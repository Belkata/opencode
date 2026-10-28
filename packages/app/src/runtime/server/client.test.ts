import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createOpenCodeEventSource, createServerTransport, eventStreamReconnect } from "./client"
import type { ServerConnection } from "./registry"

const permission = {
  id: "evt_permission",
  created: 1,
  type: "permission.asked",
  location: { directory: "/repo", workspaceID: "workspace_1" },
  data: {
    id: "perm_1",
    sessionID: "ses_1",
    action: "read",
    resources: ["src/**"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  },
} satisfies Extract<OpenCodeEvent, { type: "permission.asked" }>

function setup() {
  return createRoot((dispose) => ({ ...createOpenCodeEventSource(), dispose }))
}

describe("server event stream", () => {
  test("publishes the original current event with exact data", () => {
    const server = setup()
    const received: OpenCodeEvent[] = []
    let requestID: string | undefined

    server.event.on("permission.asked", (event) => {
      requestID = event.data.id
    })
    server.event.listen((event) => received.push(event))
    server.publish(permission)

    expect(requestID).toBe("perm_1")
    expect(received).toEqual([permission])
    expect(received[0]).toBe(permission)
    server.dispose()
  })

  test("filters locations without changing workspace identity", () => {
    const server = setup()
    const repo: OpenCodeEvent[] = []
    const other: OpenCodeEvent[] = []
    const all: OpenCodeEvent[] = []
    let workspaceID: string | undefined

    const global = {
      id: "evt_connected",
      type: "server.connected",
      data: {},
    } satisfies Extract<OpenCodeEvent, { type: "server.connected" }>

    const repoEvents = server.event.location("/repo")
    repoEvents.on("permission.asked", (event) => {
      workspaceID = event.location?.workspaceID
    })
    repoEvents.listen((event) => repo.push(event))
    server.event.location("/other").listen((event) => other.push(event))
    server.event.listen((event) => all.push(event))
    server.publish(permission)
    server.publish(global)

    expect(repo).toEqual([permission])
    expect(workspaceID).toBe("workspace_1")
    expect(other).toEqual([])
    expect(all).toEqual([permission, global])
    server.dispose()
  })

  test("isolates servers and clears subscriptions with their owner", () => {
    const first = setup()
    const second = setup()
    const received = { first: 0, second: 0 }

    first.event.listen(() => received.first++)
    second.event.listen(() => received.second++)
    first.publish(permission)
    first.dispose()
    first.publish(permission)
    second.publish(permission)

    expect(received).toEqual({ first: 1, second: 1 })
    second.dispose()
  })
})

test("rotates HTTP and PTY clients together", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = []

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({ url: request.url, authorization: request.headers.get("authorization") })

    return Response.json({
      version: "2.0.0-test",
      pid: 1,
      urls: [request.url],
      paths: { tmp: "/tmp/opencode" },
    })
  }) as typeof globalThis.fetch

  const transport = createServerTransport({
    http: { url: "http://127.0.0.1:4100", password: "first" },
    fetch,
  })

  const initialPty = transport.pty

  await transport.api.server.info()

  const replacement = transport.update({
    url: "http://127.0.0.1:4200",
    password: "second",
  })

  await transport.api.server.info()

  expect(replacement).toBe(transport.api)
  expect(transport.pty).not.toBe(initialPty)
  expect(transport.url).toBe("http://127.0.0.1:4200")
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:4100/api/info",
      authorization: `Basic ${btoa("opencode:first")}`,
    },
    {
      url: "http://127.0.0.1:4200/api/info",
      authorization: `Basic ${btoa("opencode:second")}`,
    },
  ])
})

test("event stream follows a plugin server's endpoint once the plugin reports it", async () => {
  // A plugin server restored from the last inventory starts on a placeholder, without `reconnect`.
  const entry: { http: ServerConnection.HttpBase; reconnect?: ServerConnection.Plugin["reconnect"] } = {
    http: { url: "http://127.0.0.1:0" },
  }
  const server = {
    type: "plugin",
    get http() {
      return entry.http
    },
    get reconnect() {
      return entry.reconnect
    },
  } as unknown as ServerConnection.Any
  const urls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    urls.push(request.url)
    return Response.json({ version: "2.0.0-test", pid: 1, urls: [request.url], paths: { tmp: "/tmp/opencode" } })
  }) as typeof globalThis.fetch
  const transport = createServerTransport({ http: server.http, fetch })
  const reconnect = eventStreamReconnect(server, transport)
  if (!reconnect) throw new Error("plugin servers resolve their endpoint again")

  // The plugin reports its endpoint; the app's effect moves the transport there.
  entry.http = { url: "http://localhost.:4101", password: "secret" }
  transport.update(server.http)
  await (await reconnect(new AbortController().signal)).server.info()

  // A plugin that reports `reconnect` later is asked at the next disconnect.
  entry.reconnect = async () => ({ url: "http://localhost.:4102", password: "secret" })
  await (await reconnect(new AbortController().signal)).server.info()

  expect(urls).toEqual(["http://localhost.:4101/api/info", "http://localhost.:4102/api/info"])
})

test("event stream of a server without reconnect keeps its endpoint", () => {
  const server = { type: "http", http: { url: "http://127.0.0.1:4096" } } as unknown as ServerConnection.Any
  expect(eventStreamReconnect(server, createServerTransport({ http: server.http }))).toBeUndefined()
})
