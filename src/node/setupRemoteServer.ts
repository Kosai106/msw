import * as http from 'http'
import { invariant } from 'outvariant'
import { Server as WebSocketServer } from 'socket.io'
import type { Socket } from 'socket.io-client'
import { Emitter } from 'strict-event-emitter'
import { DeferredPromise } from '@open-draft/deferred-promise'
import {
  LifeCycleEventsMap,
  RequestHandler,
  SetupApi,
  handleRequest,
  rest,
} from '~/core'
import {
  SerializedRequest,
  SerializedResponse,
  deserializeRequest,
  deserializeResponse,
  serializeRequest,
  serializeResponse,
} from '~/core/utils/request/serializeUtils'
import { LifeCycleEventEmitter } from '~/core/sharedOptions'

export const SYNC_SERVER_URL = new URL('http://localhost:50222')

export function setupRemoteServer(...handlers: Array<RequestHandler>) {
  return new SetupRemoteServerApi(...handlers)
}

export interface SetupRemoteServer {
  listen(): Promise<void>
  close(): Promise<void>

  events: LifeCycleEventEmitter<LifeCycleEventsMap>
}

export interface SyncServerEventsMap {
  request(
    serializedRequest: SerializedRequest,
    requestId: string,
  ): Promise<void> | void
  response(serializedResponse?: SerializedResponse): Promise<void> | void
}

declare global {
  var syncServer: WebSocketServer<SyncServerEventsMap> | undefined
}

export class SetupRemoteServerApi
  extends SetupApi<LifeCycleEventsMap>
  implements SetupRemoteServer
{
  protected handlers: Array<RequestHandler>
  protected emitter: Emitter<LifeCycleEventsMap>

  constructor(...handlers: Array<RequestHandler>) {
    super(...handlers)

    this.handlers = handlers
    this.emitter = new Emitter()
  }

  public async listen(): Promise<void> {
    const server = await createSyncServer()

    server.on('connection', (socket) => {
      socket.on('request', async (serializedRequest, requestId) => {
        const request = deserializeRequest(serializedRequest)
        const response = await handleRequest(
          request,
          requestId,
          this.handlers,
          { onUnhandledRequest() {} },
          this.emitter,
        )

        socket.emit(
          'response',
          response ? await serializeResponse(response) : undefined,
        )
      })

      /**
       * @todo Have the socket signal back whichever response
       * was used for whichever request. Include request ID
       * and somehow let this API know whether the response was
       * the mocked one or note.
       */
      // socket.on('response', (serializedResponse) => {
      //   const response = deserializeResponse(serializedResponse)
      //   this.emitter.emit('response', response, requestId)
      // })
    })
  }

  public printHandlers() {
    const handlers = this.listHandlers()

    handlers.forEach((handler) => {
      const { header, callFrame } = handler.info

      const pragma = handler.info.hasOwnProperty('operationType')
        ? '[graphql]'
        : '[rest]'

      console.log(`\
${`${pragma} ${header}`}
  Declaration: ${callFrame}
`)
    })
  }

  public async close(): Promise<void> {
    const { syncServer } = globalThis

    invariant(
      syncServer,
      'Failed to close a remote server: no server is running. Did you forget to call and await ".listen()"?',
    )

    await closeSyncServer(syncServer)
  }
}

/**
 * A request handler that resolves any outgoing HTTP requests
 * against any established `setupRemoteServer()` WebSocket instance.
 */
export function createRemoteServerResolver(options: {
  requestId: string
  socketPromise: Promise<Socket<SyncServerEventsMap> | undefined>
}) {
  return rest.all('*', async ({ request }) => {
    // Bypass the socket.io HTTP handshake so the sync WS server connection
    // doesn't hang forever. Check this as the first thing to unblock the handling.
    if (request.headers.get('x-msw-request-type') === 'internal-request') {
      return
    }

    const socket = await options.socketPromise

    // If the sync server hasn't been started or failed to connect,
    // skip this request handler altogether, it has no effect.
    if (socket == null) {
      return
    }

    socket.emit('request', await serializeRequest(request), options.requestId)

    const responsePromise = new DeferredPromise<Response | undefined>()

    /**
     * @todo Handle timeouts.
     * @todo Handle socket errors.
     */
    socket.on('response', (serializedResponse) => {
      responsePromise.resolve(
        serializedResponse
          ? deserializeResponse(serializedResponse)
          : undefined,
      )
    })

    return await responsePromise
  })
}

async function createSyncServer(): Promise<
  WebSocketServer<SyncServerEventsMap>
> {
  const existingSyncServer = globalThis.syncServer

  // Reuse the existing WebSocket server reference if it exists.
  // It persists on the global scope between hot updates.
  if (existingSyncServer) {
    return existingSyncServer
  }

  const serverReadyPromise = new DeferredPromise<
    WebSocketServer<SyncServerEventsMap>
  >()

  const httpServer = http.createServer()
  const ws = new WebSocketServer<SyncServerEventsMap>(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  })

  httpServer.listen(+SYNC_SERVER_URL.port, SYNC_SERVER_URL.hostname, () => {
    globalThis.syncServer = ws
    serverReadyPromise.resolve(ws)
  })

  return serverReadyPromise
}

async function closeSyncServer(server: WebSocketServer): Promise<void> {
  const serverClosePromise = new DeferredPromise<void>()

  server.close((error) => {
    if (error) {
      return serverClosePromise.reject(error)
    }

    globalThis.syncServer = undefined
    serverClosePromise.resolve()
  })

  return serverClosePromise
}
