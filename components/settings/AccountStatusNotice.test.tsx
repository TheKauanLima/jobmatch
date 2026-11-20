import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_STATUS_COPY,
  AccountStatusNoticeView,
  consumeAccountStatusFlag,
  createAccountStatusStore,
  parseAccountStatus,
  type AccountStatus,
} from "@/components/settings/AccountStatusNotice";
import {
  ACCOUNT_DELETED_URL,
  ACCOUNT_SIGNED_OUT_URL,
} from "@/lib/client/accountDeletion";

describe("parseAccountStatus", () => {
  it("reads the flags the deletion form navigates with", () => {
    expect(parseAccountStatus(new URL(ACCOUNT_DELETED_URL, "http://x").search)).toBe(
      "deleted",
    );
    expect(
      parseAccountStatus(new URL(ACCOUNT_SIGNED_OUT_URL, "http://x").search),
    ).toBe("signed_out");
  });

  it("ignores anything else", () => {
    expect(parseAccountStatus("")).toBeNull();
    expect(parseAccountStatus("?account=other")).toBeNull();
    expect(parseAccountStatus("?reset=success")).toBeNull();
  });
});

/** renderToStaticMarkup escapes apostrophes. */
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("AccountStatusNoticeView", () => {
  it("deleted: a status confirmation with a dismiss button", () => {
    const html = renderToStaticMarkup(
      <AccountStatusNoticeView status="deleted" onDismiss={() => {}} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(escaped(ACCOUNT_STATUS_COPY.deleted.title));
    expect(html).toContain("Dismiss");
    expect(html).not.toContain('role="alert"');
  });

  it("signed_out (401 replay): a confirmation, not an error, with a log-in link", () => {
    const html = renderToStaticMarkup(
      <AccountStatusNoticeView status="signed_out" onDismiss={() => {}} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(escaped(ACCOUNT_STATUS_COPY.signed_out.title));
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("danger");
  });
});

function fakeHistory() {
  return {
    state: { __NA: true } as unknown,
    replaceState: vi.fn<History["replaceState"]>(),
  };
}

describe("consumeAccountStatusFlag", () => {
  it("returns the status and removes only the account param, keeping history state", () => {
    const history = fakeHistory();
    const status = consumeAccountStatusFlag(
      { href: "https://kalify.test/?account=deleted&ref=x#top" },
      history,
    );
    expect(status).toBe("deleted");
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    const [state, unused, url] = history.replaceState.mock.calls[0];
    expect(state).toBe(history.state);
    expect(unused).toBe("");
    expect(String(url)).toBe("https://kalify.test/?ref=x#top");
  });

  it("a second read (reload or back/forward after removal) finds nothing", () => {
    const history = fakeHistory();
    let href = "https://kalify.test/?account=signed_out";
    history.replaceState.mockImplementation((_state, _unused, url) => {
      href = String(url);
    });
    expect(consumeAccountStatusFlag({ href }, history)).toBe("signed_out");
    expect(consumeAccountStatusFlag({ href }, history)).toBeNull();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("strips an unrecognized account value without showing anything", () => {
    const history = fakeHistory();
    expect(
      consumeAccountStatusFlag({ href: "https://kalify.test/?account=bogus" }, history),
    ).toBeNull();
    expect(String(history.replaceState.mock.calls[0][2])).toBe(
      "https://kalify.test/",
    );
  });

  it("leaves the URL alone when there is no flag", () => {
    const history = fakeHistory();
    expect(
      consumeAccountStatusFlag({ href: "https://kalify.test/" }, history),
    ).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});

describe("createAccountStatusStore", () => {
  function setup(flags: (AccountStatus | null)[]) {
    const deferred: (() => void)[] = [];
    const readFlag = vi.fn(() => flags.shift() ?? null);
    const store = createAccountStatusStore(readFlag, (fn) => deferred.push(fn));
    const flush = () => deferred.splice(0).forEach((fn) => fn());
    return { store, flush };
  }

  it("server snapshot is always null (/ is static)", () => {
    expect(setup(["deleted"]).store.getServerSnapshot()).toBeNull();
  });

  it("keeps the status in memory after the URL flag is consumed", () => {
    const { store } = setup(["deleted"]);
    const listener = vi.fn();
    expect(store.getSnapshot()).toBeNull();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe("deleted");
  });

  it("survives a StrictMode synchronous unsubscribe/resubscribe on mount", () => {
    const { store, flush } = setup(["deleted"]);
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    store.subscribe(() => {}); // the flag is already gone from the URL
    flush();
    expect(store.getSnapshot()).toBe("deleted");
  });

  it("forgets the status after a real unmount, so a later visit does not show it", () => {
    const { store, flush } = setup(["deleted"]);
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    flush();
    expect(store.getSnapshot()).toBeNull();
    store.subscribe(() => {});
    expect(store.getSnapshot()).toBeNull();
  });

  it("dismiss clears the status and notifies", () => {
    const { store } = setup(["signed_out"]);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dismiss();
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
