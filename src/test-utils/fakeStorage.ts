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

/** A `Storage` whose `setItem` throws QuotaExceededError exactly once (its
 * first call), then behaves like a normal in-memory store -- simulates quota
 * being freed by the cache's purge-and-retry backstop. */
export class QuotaOnceThenOkStorage implements Storage {
  private readonly map = new Map<string, string>();
  private setItemCalls = 0;

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
    this.setItemCalls += 1;
    if (this.setItemCalls === 1) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    this.map.set(key, value);
  }
}
