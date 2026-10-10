// jsdom has no SubtleCrypto. Use Node's real WebCrypto for fingerprint tests.
import { webcrypto } from 'node:crypto'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
