/** Strict JSON parsing, cloning, canonical serialization, and freezing. */

import { AutoDataCoreError } from './errors.js'
import type { JsonObject, JsonValue } from './types.js'

/** Fail one strict JSON parse with a stable code and byte-offset context. */
function invalidJson(label: string, offset: number, message: string): never {
  throw new AutoDataCoreError(`${label}: ${message} at offset ${String(offset)}`, 'INVALID_JSON')
}

/** Recursive-descent parser used because native JSON.parse silently accepts duplicate object keys. */
class StrictJsonParser {
  private offset = 0

  constructor(private readonly text: string, private readonly label: string) {}

  /** Parse exactly one JSON value and reject trailing input. */
  parse(): JsonValue {
    this.skipWhitespace()
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.offset !== this.text.length) invalidJson(this.label, this.offset, 'unexpected trailing input')
    return value
  }

  private parseValue(): JsonValue {
    const character = this.text[this.offset]
    if (character === '"') return this.parseString()
    if (character === '{') return this.parseObject()
    if (character === '[') return this.parseArray()
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      return this.parseNumber()
    }
    if (this.text.startsWith('true', this.offset)) {
      this.offset += 4
      return true
    }
    if (this.text.startsWith('false', this.offset)) {
      this.offset += 5
      return false
    }
    if (this.text.startsWith('null', this.offset)) {
      this.offset += 4
      return null
    }
    return invalidJson(this.label, this.offset, 'expected a JSON value')
  }

  private parseObject(): JsonObject {
    this.offset += 1
    this.skipWhitespace()
    const value: Record<string, JsonValue> = {}
    const keys = new Set<string>()
    if (this.text[this.offset] === '}') {
      this.offset += 1
      return value
    }
    for (;;) {
      if (this.text[this.offset] !== '"') invalidJson(this.label, this.offset, 'expected an object key')
      const key = this.parseString()
      if (keys.has(key)) invalidJson(this.label, this.offset, `duplicate object key ${JSON.stringify(key)}`)
      keys.add(key)
      this.skipWhitespace()
      if (this.text[this.offset] !== ':') invalidJson(this.label, this.offset, 'expected colon after object key')
      this.offset += 1
      this.skipWhitespace()
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: this.parseValue(),
        writable: true,
      })
      this.skipWhitespace()
      const separator = this.text[this.offset]
      if (separator === '}') {
        this.offset += 1
        return value
      }
      if (separator !== ',') invalidJson(this.label, this.offset, 'expected comma or closing brace')
      this.offset += 1
      this.skipWhitespace()
    }
  }

  private parseArray(): JsonValue[] {
    this.offset += 1
    this.skipWhitespace()
    const value: JsonValue[] = []
    if (this.text[this.offset] === ']') {
      this.offset += 1
      return value
    }
    for (;;) {
      value.push(this.parseValue())
      this.skipWhitespace()
      const separator = this.text[this.offset]
      if (separator === ']') {
        this.offset += 1
        return value
      }
      if (separator !== ',') invalidJson(this.label, this.offset, 'expected comma or closing bracket')
      this.offset += 1
      this.skipWhitespace()
    }
  }

  private parseString(): string {
    const start = this.offset
    this.offset += 1
    let escaped = false
    while (this.offset < this.text.length) {
      const character = this.text[this.offset]
      if (escaped) {
        escaped = false
        this.offset += 1
        continue
      }
      if (character === '\\') {
        escaped = true
        this.offset += 1
        continue
      }
      if (character === '"') {
        this.offset += 1
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string
        } catch (error) {
          throw new AutoDataCoreError(`${this.label}: invalid JSON string at offset ${String(start)}`, 'INVALID_JSON', {
            cause: error,
          })
        }
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) {
        invalidJson(this.label, this.offset, 'unescaped control character in string')
      }
      this.offset += 1
    }
    return invalidJson(this.label, start, 'unterminated string')
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset))
    if (match === null) return invalidJson(this.label, this.offset, 'invalid number')
    this.offset += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) return invalidJson(this.label, this.offset, 'number is not finite')
    return value
  }

  private skipWhitespace(): void {
    while (this.offset < this.text.length && /[\t\n\r ]/u.test(this.text.charAt(this.offset))) this.offset += 1
  }
}

/**
 * Parse one strict JSON value, rejecting duplicate keys and non-finite numbers.
 * @param text - complete JSON text.
 * @param label - source name included in failures.
 * @returns the parsed JSON value with source object-key order retained.
 */
export function parseStrictJson(text: string, label = 'JSON'): JsonValue {
  return new StrictJsonParser(text, label).parse()
}

/**
 * Parse one strict JSON object.
 * @param text - complete JSON object text.
 * @param label - source name included in failures.
 * @returns the parsed object.
 */
export function parseStrictJsonObject(text: string, label = 'JSON'): JsonObject {
  const value = parseStrictJson(text, label)
  if (!isJsonObject(value)) throw new AutoDataCoreError(`${label}: expected a JSON object`, 'INVALID_JSON')
  return value
}

/**
 * Whether a value is a non-array object.
 * @param value - candidate value.
 * @returns true for JSON object candidates.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clone a value while rejecting every non-JSON value and cycle. */
function cloneJsonInner(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AutoDataCoreError(`${path} contains a non-finite number`, 'INVALID_JSON')
    return value
  }
  if (typeof value !== 'object') {
    throw new AutoDataCoreError(`${path} contains non-JSON value ${typeof value}`, 'INVALID_JSON')
  }
  if (ancestors.has(value)) throw new AutoDataCoreError(`${path} contains a cycle`, 'INVALID_JSON')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneJsonInner(entry, `${path}[${String(index)}]`, ancestors))
    }
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AutoDataCoreError(`${path} must be a plain JSON object`, 'INVALID_JSON')
    }
    const copy: Record<string, JsonValue> = {}
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonInner((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors),
        writable: true,
      })
    }
    return copy
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Clone JSON-compatible data while retaining object-key order.
 * @param value - untrusted value at a JSON boundary.
 * @param path - diagnostic root path.
 * @returns a detached JSON value.
 */
export function cloneJson(value: unknown, path = '$'): JsonValue {
  return cloneJsonInner(value, path, new Set())
}

/** Sort object keys recursively and serialize without insignificant whitespace. */
function canonicalJsonInner(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    // `cloneJson` admits only JSON primitives here, for which stringify is total.
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonInner).join(',')}]`
  const entries = Object.entries(value as JsonObject).sort(([left], [right]) => left < right ? -1 : 1)
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonInner(entry)}`).join(',')}}`
}

/**
 * Serialize JSON data with recursive lexical object-key ordering.
 * @param value - strict JSON data.
 * @returns deterministic UTF-8 text for normalized comparisons and summaries.
 */
export function canonicalJson(value: unknown): string {
  return canonicalJsonInner(cloneJson(value))
}

/**
 * Serialize records as compact JSONL while retaining nested object-key order.
 * @param records - strict JSON objects in output order.
 * @returns newline-terminated JSONL, or the empty string for no records.
 */
/** Deep-freeze one already-cloned JSON value. */
function freezeJsonInner<T extends JsonValue>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    for (const entry of value) freezeJsonInner(entry)
  } else {
    for (const entry of Object.values(value)) freezeJsonInner(entry)
  }
  return Object.freeze(value)
}

/**
 * Return an immutable detached JSON value.
 * @param value - untrusted JSON-compatible value.
 * @returns a deep-cloned and deep-frozen value.
 */
export function immutableJson(value: unknown): JsonValue {
  return freezeJsonInner(cloneJson(value))
}
