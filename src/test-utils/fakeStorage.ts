/** A minimal in-memory `Storage` implementation for tests that need an
 * isolated, inspectable localStorage stand-in (as opposed to jsdom's real one,
 * which is process-global and would leak state between tests). */
export class FakeStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** A `Storage` whose `getItem` always throws -- simulates a browser context
 * (e.g. some private-browsing modes) where localStorage reads throw outright. */
export class ThrowingReadStorage implements Storage {
  get length(): number {
    return 0;
  }
  clear(): void {
    throw new Error('storage disabled');
  }
  getItem(_key: string): string | null {
    throw new Error('storage disabled');
  }
  key(_index: number): string | null {
    throw new Error('storage disabled');
  }
  removeItem(_key: string): void {
    throw new Error('storage disabled');
  }
  setItem(_key: string, _value: string): void {
    throw new Error('storage disabled');
  }
}

/** A `Storage` whose `setItem` always throws a generic (non-quota) error. */
export class ThrowingWriteStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(_key: string, _value: string): void {
    throw new Error('disk full (not a quota error)');
  }
}

/** A `FakeStorage` that throws QuotaExceededError once its keys and values would pass `capacity` characters, as browsers do. */
export class CapacityStorage extends FakeStorage {
  private readonly capacity: number;

  constructor(capacity: number) {
    super();
    this.capacity = capacity;
  }

  usedChars(): number {
    let used = 0;
    for (let i = 0; i < this.length; i += 1) {
      const key = this.key(i) as string;
      used += key.length + (this.getItem(key) as string).length;
    }
    return used;
  }

  override setItem(key: string, value: string): void {
    const previous = this.getItem(key);
    const growth = key.length + value.length - (previous == null ? 0 : key.length + previous.length);
    if (this.usedChars() + growth > this.capacity) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    super.setItem(key, value);
  }
}
