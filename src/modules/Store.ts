import { openDB, type IDBPDatabase } from "idb"

export type ExpirationSettings = {
	Duration: number
	Unit: "Weeks" | "Months" | "Days" | "Hours" | "Minutes" | "Seconds"
}

export type ExpireStoreInterface<ItemType> = {
	GetItem: (itemName: string) => Promise<ItemType | undefined>
	SetItem: (itemName: string, content: ItemType) => Promise<ItemType>
	RemoveItem: (itemName: string) => Promise<void>
	Destroy: () => Promise<void>
}

type ExpireItem<C> = {
	ExpiresAt: number
	CacheVersion: number
	Content: C
}

type InstantEnvelope<T> = {
	Version: number
	Items: T
}

const instantStoreRegistry = new Set<string>()
const expireStoreRegistry = new Set<string>()
const expireStoreListeners = new Set<() => void>()

export function onExpireStoreChange(cb: () => void): () => void {
	expireStoreListeners.add(cb)
	return () => {
		expireStoreListeners.delete(cb)
	}
}

function notifyExpireStoreChange(): void {
	for (const cb of expireStoreListeners) {
		try {
			cb()
		} catch {}
	}
}

const EXPIRE_IDB_NAME = "spicylyrics-expire-cache"
const EXPIRE_IDB_STORE = "entries"

let expireDbPromise: Promise<IDBPDatabase> | null = null

function getExpireDb(): Promise<IDBPDatabase> | null {
	if (typeof indexedDB === "undefined") return null
	if (!expireDbPromise) {
		expireDbPromise = openDB(EXPIRE_IDB_NAME, 1, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(EXPIRE_IDB_STORE)) {
					db.createObjectStore(EXPIRE_IDB_STORE)
				}
			},
		}).catch((err) => {
			console.warn("ExpireStore: failed to open IndexedDB backing store", err)
			expireDbPromise = null
			throw err
		})
	}
	return expireDbPromise
}

const deepClone = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

const topUp = (
	target: Record<string, unknown>,
	template: Record<string, unknown>,
	path: string,
): void => {
	for (const key of Object.keys(template)) {
		const tplValue = template[key]
		const subPath = `${path}.${key}`

		if (!(key in target)) {
			target[key] = deepClone(tplValue)
			continue
		}

		const tgtValue = target[key]
		const tplIsObj = isPlainObject(tplValue)
		const tgtIsObj = isPlainObject(tgtValue)

		if (tplIsObj && tgtIsObj) {
			topUp(tgtValue, tplValue, subPath)
			continue
		}

		if (typeof tplValue !== typeof tgtValue) {
			throw new Error(`Template Type mismatch at ${subPath}`)
		}
	}
}

const computeExpiresAt = (settings: ExpirationSettings): number => {
	const date = new Date()
	const { Duration, Unit } = settings

	switch (Unit) {
		case "Seconds":
			return date.getTime() + Duration * 1_000
		case "Minutes":
			return date.getTime() + Duration * 60_000
		case "Hours":
			return date.getTime() + Duration * 3_600_000
		case "Days":
			return date.getTime() + Duration * 86_400_000
		case "Weeks":
			return date.getTime() + Duration * 7 * 86_400_000
		case "Months":
			date.setMonth(date.getMonth() + Duration)
			return date.getTime()
	}
}

export function GetInstantStore<T extends Record<string, unknown>>(
	storeName: string,
	version: number,
	template: T,
	forceNewData?: true,
): Readonly<{ Items: T; SaveChanges: () => void }> {
	if (instantStoreRegistry.has(storeName)) {
		throw new Error(`InstantStore "${storeName}" has already been retrieved`)
	}
	instantStoreRegistry.add(storeName)

	let items: T

	if (forceNewData) {
		items = deepClone(template)
	} else {
		const raw = localStorage.getItem(storeName)
		let parsed: InstantEnvelope<T> | null = null

		if (raw !== null) {
			try {
				parsed = JSON.parse(raw) as InstantEnvelope<T>
			} catch {
				parsed = null
			}
		}

		items = deepClone(template)
		if (parsed !== null && parsed.Version === version && isPlainObject(parsed.Items)) {
			// A malformed record must not throw here: stores are created at import
			// time, so one bad entry would break every module that imports this one
			// until storage was cleared by hand. Start over from the template.
			try {
				topUp(
					parsed.Items as Record<string, unknown>,
					template as Record<string, unknown>,
					`${storeName}.Items`,
				)
				items = parsed.Items
			} catch (err) {
				console.warn(`InstantStore "${storeName}": stored data is malformed, resetting`, err)
			}
		}
	}

	const envelope: InstantEnvelope<T> = { Version: version, Items: items }

	const SaveChanges = (): void => {
		localStorage.setItem(storeName, JSON.stringify(envelope))
	}

	return Object.freeze({ Items: items, SaveChanges })
}

/**
 * Reads a Dynamic Store entry. The generic `I` is unchecked at runtime —
 * the value is always a raw string and is cast directly. Callers are
 * responsible for knowing the expected format.
 */
export function GetDynamicStoreItem<I>(
	storeName: string,
	itemName: string,
): I | undefined {
	const raw = localStorage.getItem(`${storeName}:${itemName}`)
	if (raw === null) return undefined
	return raw as unknown as I
}

export function SetDynamicStoreItem(
	storeName: string,
	itemName: string,
	content: string,
): void {
	localStorage.setItem(`${storeName}:${itemName}`, content)
}

export function GetExpireStore<ItemType>(
	storeName: string,
	version: number,
	itemExpirationSettings: ExpirationSettings,
	forceNewData?: true,
): Readonly<ExpireStoreInterface<ItemType>> {
	if (expireStoreRegistry.has(storeName)) {
		throw new Error(`ExpireStore "${storeName}" has already been retrieved`)
	}
	expireStoreRegistry.add(storeName)

	const requestUrl = (itemName: string): string => `/${encodeURIComponent(itemName)}`
	const legacyRequestUrl = (itemName: string): string => `/${itemName}`
	const idbKey = (itemName: string): string => `${storeName}:${itemName}`

	const GetItem = async (itemName: string): Promise<ItemType | undefined> => {
		if (forceNewData) return undefined
		const now = Date.now()

		// 1. Check IndexedDB backing store first (persists reliably across app & PC restarts)
		try {
			const db = await getExpireDb()
			if (db) {
				const idbWrapped = (await db.get(
					EXPIRE_IDB_STORE,
					idbKey(itemName),
				)) as ExpireItem<ItemType> | undefined
				if (idbWrapped) {
					if (idbWrapped.CacheVersion === version && idbWrapped.ExpiresAt >= now) {
						return idbWrapped.Content
					}
					void db.delete(EXPIRE_IDB_STORE, idbKey(itemName)).catch(() => {})
				}
			}
		} catch {}

		// 2. Fallback to CacheStorage (and backfill IndexedDB if found)
		if (typeof caches !== "undefined") {
			try {
				const cache = await caches.open(storeName)
				const response =
					(await cache.match(requestUrl(itemName))) ??
					(await cache.match(legacyRequestUrl(itemName)))
				if (!response) return undefined

				const wrapped = (await response.json()) as ExpireItem<ItemType>
				if (wrapped.CacheVersion !== version || wrapped.ExpiresAt < now) {
					return undefined
				}

				try {
					const db = await getExpireDb()
					if (db) {
						await db.put(EXPIRE_IDB_STORE, wrapped, idbKey(itemName))
					}
				} catch {}

				return wrapped.Content
			} catch {}
		}

		return undefined
	}

	const SetItem = async (
		itemName: string,
		content: ItemType,
	): Promise<ItemType> => {
		const wrapped: ExpireItem<ItemType> = {
			ExpiresAt: computeExpiresAt(itemExpirationSettings),
			CacheVersion: version,
			Content: content,
		}

		try {
			const db = await getExpireDb()
			if (db) {
				await db.put(EXPIRE_IDB_STORE, wrapped, idbKey(itemName))
			}
		} catch (err) {
			console.warn(
				`ExpireStore "${storeName}": failed to write item "${itemName}" to IndexedDB`,
				err,
			)
		}

		if (typeof caches !== "undefined") {
			try {
				const cache = await caches.open(storeName)
				await cache.put(
					requestUrl(itemName),
					new Response(JSON.stringify(wrapped), {
						headers: { "Content-Type": "application/json" },
					}),
				)
			} catch (err) {
				console.warn(
					`ExpireStore "${storeName}": failed to write item "${itemName}" to CacheStorage`,
					err,
				)
			}
		}

		notifyExpireStoreChange()
		return content
	}

	const RemoveItem = async (itemName: string): Promise<void> => {
		try {
			const db = await getExpireDb()
			if (db) {
				await db.delete(EXPIRE_IDB_STORE, idbKey(itemName))
			}
		} catch {}

		if (typeof caches !== "undefined") {
			try {
				const cache = await caches.open(storeName)
				await cache.delete(requestUrl(itemName))
				await cache.delete(legacyRequestUrl(itemName))
			} catch (err) {
				console.warn(
					`ExpireStore "${storeName}": error removing item "${itemName}"`,
					err,
				)
			}
		}

		notifyExpireStoreChange()
	}

	const Destroy = async (): Promise<void> => {
		try {
			const db = await getExpireDb()
			if (db) {
				const allKeys = await db.getAllKeys(EXPIRE_IDB_STORE)
				const prefix = `${storeName}:`
				const tx = db.transaction(EXPIRE_IDB_STORE, "readwrite")
				for (const k of allKeys) {
					if (typeof k === "string" && k.startsWith(prefix)) {
						void tx.store.delete(k)
					}
				}
				await tx.done
			}
		} catch (err) {
			console.warn(`ExpireStore "${storeName}": error clearing IndexedDB`, err)
		}

		if (typeof caches !== "undefined") {
			try {
				await caches.delete(storeName)
			} catch (err) {
				console.warn(`ExpireStore "${storeName}": error destroying CacheStorage`, err)
			}
		}

		notifyExpireStoreChange()
	}

	return Object.freeze({ GetItem, SetItem, RemoveItem, Destroy })
}

export async function getExpireStoreSizeBytes(
	storeNames?: string[],
): Promise<{ bytes: number; count: number }> {
	const targets = new Set(
		storeNames && storeNames.length > 0
			? storeNames
			: Array.from(expireStoreRegistry),
	)
	const seen = new Map<string, number>()
	const encoder = new TextEncoder()
	const now = Date.now()

	try {
		const db = await getExpireDb()
		if (db) {
			const allKeys = await db.getAllKeys(EXPIRE_IDB_STORE)
			for (const rawKey of allKeys) {
				if (typeof rawKey !== "string") continue
				const colonIdx = rawKey.indexOf(":")
				if (colonIdx <= 0) continue
				const sName = rawKey.slice(0, colonIdx)
				if (!targets.has(sName)) continue
				const val = (await db.get(EXPIRE_IDB_STORE, rawKey)) as
					| ExpireItem<unknown>
					| undefined
				if (!val || (typeof val.ExpiresAt === "number" && val.ExpiresAt < now)) {
					continue
				}
				const serialized = JSON.stringify(val)
				seen.set(rawKey, encoder.encode(serialized).byteLength + rawKey.length)
			}
		}
	} catch {}

	if (typeof caches !== "undefined") {
		for (const sName of targets) {
			try {
				const exists =
					typeof caches.has === "function" ? await caches.has(sName) : true
				if (!exists) continue
				const cache = await caches.open(sName)
				const requests = await cache.keys()
				for (const req of requests) {
					let itemName = req.url
					try {
						const u = new URL(req.url)
						itemName = decodeURIComponent(u.pathname.replace(/^\//, ""))
					} catch {}
					const fullKey = `${sName}:${itemName}`
					if (seen.has(fullKey)) continue
					const res = await cache.match(req)
					if (!res) continue
					const text = await res.text()
					try {
						const parsed = JSON.parse(text) as ExpireItem<unknown>
						if (typeof parsed.ExpiresAt === "number" && parsed.ExpiresAt < now) {
							continue
						}
					} catch {}
					seen.set(fullKey, encoder.encode(text).byteLength + fullKey.length)
				}
			} catch {}
		}
	}

	let totalBytes = 0
	for (const b of seen.values()) {
		totalBytes += b
	}
	return { bytes: totalBytes, count: seen.size }
}
