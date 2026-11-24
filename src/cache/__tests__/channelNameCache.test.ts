import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeStorage, ThrowingReadStorage, ThrowingWriteStorage } from '../../test-utils/fakeStorage';
import { ChannelNameCache } from '../channelNameCache';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChannelNameCache', () => {
  it('reads back what was recorded, across instances on the same storage', () => {
    const storage = new FakeStorage();
    new ChannelNameCache(storage).record({ present: ['stable-4.14', 'eus-4.14'], empty: ['fast-4.13'] });

    expect(new ChannelNameCache(storage).read()).toEqual({ present: ['stable-4.14', 'eus-4.14'], empty: ['fast-4.13'] });
  });

  it('unions each record into what is already stored', () => {
    const cache = new ChannelNameCache(new FakeStorage());
    cache.record({ present: ['stable-4.17'], empty: [] });
    cache.record({ present: ['stable-4.17', 'eus-4.16'], empty: ['candidate-4.15'] });

    expect(cache.read()).toEqual({ present: ['stable-4.17', 'eus-4.16'], empty: ['candidate-4.15'] });
  });

  it('forgets everything a day after the last record', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const cache = new ChannelNameCache(new FakeStorage());
    cache.record({ present: ['stable-4.14'], empty: [] });

    now.mockReturnValue(1_000_000 + DAY_MS - 1);
    expect(cache.read().present).toEqual(['stable-4.14']);
    now.mockReturnValue(1_000_000 + DAY_MS + 1);
    expect(cache.read()).toEqual({ present: [], empty: [] });
  });

  it('treats corrupt or foreign data as empty', () => {
    const storage = new FakeStorage();
    const cache = new ChannelNameCache(storage);
    cache.record({ present: ['stable-4.14'], empty: [] });
    for (const key of Array.from({ length: storage.length }, (_, i) => storage.key(i) as string)) {
      storage.setItem(key, '{"savedAt":"soon","present":[1]}');
    }

    expect(cache.read()).toEqual({ present: [], empty: [] });
  });

  it('never throws when storage is unavailable', () => {
    expect(new ChannelNameCache(new ThrowingReadStorage()).read()).toEqual({ present: [], empty: [] });
    expect(() => new ChannelNameCache(new ThrowingWriteStorage()).record({ present: ['stable-4.14'], empty: [] })).not.toThrow();
  });
});
