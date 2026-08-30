import { describe, expect, it } from "vitest";
import { resolveActiveProjectTab } from "../project-nav";

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";

describe("resolveActiveProjectTab", () => {
  it("resolves each top-level tab", () => {
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/chat`, PROJECT_ID)).toBe("chat");
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/documents`, PROJECT_ID)).toBe("documents");
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/model`, PROJECT_ID)).toBe("model");
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/channels`, PROJECT_ID)).toBe("channels");
  });

  it("resolves a nested chat conversation route to the 'chat' tab", () => {
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/chat/some-conversation-id`, PROJECT_ID)).toBe("chat");
  });

  it("resolves a nested channels transcript route to the 'channels' tab", () => {
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/channels/some-conversation-id`, PROJECT_ID)).toBe(
      "channels"
    );
  });

  it("returns null for a path under a different project id", () => {
    expect(resolveActiveProjectTab(`/projects/other-project/chat`, PROJECT_ID)).toBeNull();
  });

  it("returns null for a path outside /projects/{id}/** entirely", () => {
    expect(resolveActiveProjectTab("/profile", PROJECT_ID)).toBeNull();
    expect(resolveActiveProjectTab("/projects", PROJECT_ID)).toBeNull();
  });

  it("returns null for an unrecognized first segment under the project", () => {
    expect(resolveActiveProjectTab(`/projects/${PROJECT_ID}/settings`, PROJECT_ID)).toBeNull();
  });
});
