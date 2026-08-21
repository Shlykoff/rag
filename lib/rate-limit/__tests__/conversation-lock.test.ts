import { afterEach, describe, expect, it } from "vitest";
import {
  acquireConversationLock,
  releaseConversationLock,
  __resetConversationLocksForTests,
} from "../conversation-lock";

describe("conversation lock (layer 3: per-conversation mutual exclusion)", () => {
  afterEach(() => {
    __resetConversationLocksForTests();
  });

  it("acquires a free lock", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
  });

  it("rejects a second acquire for the SAME (project, channel, participant) while the first is still held -- reject, don't queue", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(false);
    // A third attempt while still held is also rejected, not queued behind the second.
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(false);
  });

  it("allows re-acquiring after release", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
    releaseConversationLock("project-1", "telegram", "participant-1");
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
  });

  it("release is idempotent -- calling it when not held (or twice) is a safe no-op, never frees someone else's lock", () => {
    // Never acquired at all.
    expect(() => releaseConversationLock("project-1", "telegram", "never-locked")).not.toThrow();

    acquireConversationLock("project-1", "telegram", "participant-1");
    releaseConversationLock("project-1", "telegram", "participant-1");
    // Second release of the same key, already free -- still a no-op.
    expect(() => releaseConversationLock("project-1", "telegram", "participant-1")).not.toThrow();
    // And the lock is genuinely free, not accidentally double-held.
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
  });

  it("two different participants never block each other, even within the same project/channel", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-a")).toBe(true);
    expect(acquireConversationLock("project-1", "telegram", "participant-b")).toBe(true);
    // Both held concurrently -- neither blocked the other's acquire.
    expect(acquireConversationLock("project-1", "telegram", "participant-a")).toBe(false);
    expect(acquireConversationLock("project-1", "telegram", "participant-b")).toBe(false);
  });

  it("scopes by project too -- the SAME externalParticipantId in a DIFFERENT project is an independent lock", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
    expect(acquireConversationLock("project-2", "telegram", "participant-1")).toBe(true);
  });

  it("scopes by channel too -- the SAME externalParticipantId on a DIFFERENT channel is an independent lock", () => {
    expect(acquireConversationLock("project-1", "telegram", "participant-1")).toBe(true);
    expect(acquireConversationLock("project-1", "slack", "participant-1")).toBe(true);
  });
});
