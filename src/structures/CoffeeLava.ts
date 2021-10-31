/* eslint-disable func-names */
/* eslint-disable prefer-arrow-callback */
import { CoffeeNode } from "./CoffeeNode"
import { CoffeePlayer } from "./CoffeePlayer"
import { LavaOptions, NodeOptions, PlayerOptions, SearchQuery, SearchResult } from "../utils/typings"
import { TypedEmitter } from "tiny-typed-emitter"
import { EventPayloads, TrackEndPayload, TrackExceptionPayload, TrackStartPayload, TrackStuckPayload, VoiceServerUpdate, VoiceStateUpdate, WebSocketClosedPayload } from "../utils/payloads"
import { check } from "../utils/decorators/validators"
import { EventTypes, LoopMode, OpCodes, PlayerStates, PlayerVoiceStates } from "../utils/constants"
import { constructCoffee } from "../utils/decorators/constructs"
import { CoffeeTrack, UnresolvedTrack } from "./CoffeeTrack"
import { LoadTypes, TrackData, TrackInfo, TracksData } from "../utils/rest"

export interface LavaEvents {
  /** Emitted when a node is created */
  nodeCreate(node: CoffeeNode): void
  /** Emitted when a node is destroyed */
  nodeDestroy(node: CoffeeNode): void
  /** Emitted when a node connects */
  nodeConnect(node: CoffeeNode): void
  /** Emitted when a Node reconnects */
  nodeReconnect(node: CoffeeNode): void
  /** Emitted when a Node disconnects */
  nodeDisconnect(node: CoffeeNode, reason: { code: number, reason: string }): void
  /** Emitted when a Node has an error */
  nodeError(node: CoffeeNode, error: Error): void
  /** Emitted whenever any Lavalink event is received */
  nodeRaw(node: CoffeeNode, payload: unknown): void
  /** Emitted whenever a Player is created */
  playerCreate(player: CoffeePlayer): void
  /** Emitted whenever a Player is destroyed */
  playerDestroy(player: CoffeePlayer): void
  /** Emitted whenever a Player is replaying after moving node */
  playerReplay(player: CoffeePlayer): void
  /** Emitted whenever an error occured when replaying track */
  replayError(player: CoffeePlayer, error: Error): void
  /** Emitted whenever a Player is moved to other channel */
  playerMove(player: CoffeePlayer, oldChannel: string | undefined, newChannel: string | undefined): void
  /** Emitted whenever queue is started */
  queueStart(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackStartPayload): void
  /** Emitted whenever queue is ended */
  queueEnd(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackEndPayload): void
  /** Emitted whenever a track start */
  trackStart(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackStartPayload): void
  /** Emitted whenever a track end */
  trackEnd(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackEndPayload): void
  /** Emitted whenever a track stuck during playback */
  trackStuck(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackStuckPayload): void
  /** Emitted whenever a track occur an error during playback */
  trackError(player: CoffeePlayer, track: CoffeeTrack | UnresolvedTrack, payload: TrackExceptionPayload): void
  /** Emitted whenever a voice connection is closed */
  socketClosed(player: CoffeePlayer, payload: WebSocketClosedPayload): void
}

/**
 * The main hub for interacting with Lavalink and using LavaCoffee
 */
@constructCoffee()
export class CoffeeLava extends TypedEmitter<LavaEvents> {
  public clientID?: string
  public options: LavaOptions
  public readonly nodes = new Map<string, CoffeeNode>()
  public readonly players = new Map<string, CoffeePlayer>()

  public constructor(options: LavaOptions) {
    super()
    this.options = {
      clientName: "node-lavacoffee",
      shards: 1,
      autoPlay: true,
      defaultSearchPlatform: "yt",
      autoReplay: true,
      autoResume: true,
      ...options
    }
  }

  public get leastUsedNode(): CoffeeNode | undefined {
    return this.sortAndGetFirstNode((l, r) => l.calls - r.calls)
  }

  public get leastLoadNode(): CoffeeNode | undefined {
    return this.sortAndGetFirstNode((l, r) => {
      const lLoad = l.stats.cpu
        ? (l.stats.cpu.systemLoad / l.stats.cpu.cores) * 100
        : 0
      const rLoad = r.stats.cpu
        ? (r.stats.cpu.systemLoad / r.stats.cpu.cores) * 100
        : 0
      return lLoad - rLoad
    })
  }

  /** Initiate the Lavalink client */
  @check(function (this: CoffeeLava, method, clientID: string) {
    if (this.clientID) return
    if (
      typeof clientID !== "string" || !clientID
    ) throw new TypeError("Parameter 'clientID' must be present and be a non-empty string")
    return method(clientID)
  })
  public init(clientID: string): void {
    this.clientID = clientID
    for (const node of this.nodes.values()) node.connect()
  }

  /** Searches some tracks based off the URL or the `source` property */
  @check(function (this: CoffeeLava, method, query: SearchQuery, requester?: unknown) {
    if (
      typeof query !== "object" ||
      query === null
    ) throw new TypeError("Parameter 'query' must be present and be an object")
    const node = this.leastUsedNode
    if (!node || !node.connected) throw new Error("No node is available currently")
    return method(query, requester)
  })
  public async search(query: SearchQuery, requester?: unknown): Promise<SearchResult> {
    const node = this.leastUsedNode!
    const source = query.source ?? this.options.defaultSearchPlatform!
    let search = query.query

    if (!/^(?:http|https):\/\//.test(search)) search = `${source}search:${search}`

    const res = await node.request<TracksData>(`/loadtracks?identifier=${encodeURIComponent(search)}`)

    if (!res) throw new Error("Query not found")

    const result: SearchResult = {
      loadType: res.loadType,
      tracks: res.tracks.map(track => new CoffeeTrack(track, requester))
    }

    if (res.loadType === LoadTypes.LoadFailed) {
      result.error = res.exception
    }

    if (res.loadType === LoadTypes.PlaylistLoaded) {
      result.playlist = {
        name: res.playlistInfo!.name,
        selectedTrack: res.playlistInfo!.selectedTrack === -1
          ? null
          : result.tracks[res.playlistInfo!.selectedTrack],
        duration: result.tracks.reduce((acc, tr) => acc + (tr.duration || 0), 0)
      }
    }

    return result
  }

  /** Decode the base64 track into TrackData */
  @check(function (this: CoffeeLava, method, track: string) {
    if (
      typeof track !== "string" || !track
    ) throw new TypeError("Parameter 'track' must be present and be a non-empty string")
    const node = this.leastUsedNode
    if (!node || !node.connected) throw new Error("No node is available currently")
    return method(track)
  })
  public async decodeTrack(track: string): Promise<TrackData> {
    const node = this.leastUsedNode!
    const res = await node.request<TrackInfo>(`/decodetrack?track=${track}`)

    if (!res) throw new Error("No decoded data returned")

    const data: TrackData = {
      track,
      info: res
    }

    return data
  }

  /** Send voice data to the Lavalink server */
  @check(function (this: CoffeeLava, method, p: VoiceServerUpdate | VoiceStateUpdate) {
    if (
      !p ||
      !["VOICE_SERVER_UPDATE", "VOICE_STATE_UPDATE"].includes(p.t || "")
    ) return
    if (!this.players.has(p.d.guild_id)) return
    if (
      p.t === "VOICE_STATE_UPDATE" &&
      p.d.user_id !== this.clientID
    ) return

    return method(p)
  })
  public updateVoiceData(p: VoiceServerUpdate | VoiceStateUpdate): void {
    const player = this.players.get(p.d.guild_id)!
    const voice = player.voice

    if (p.t === "VOICE_SERVER_UPDATE") {
      voice.op = OpCodes.VoiceUpdate
      voice.guildId = p.d.guild_id
      voice.event = p.d
    } else {
      voice.sessionId = p.d.session_id
      if (player.options.voiceID !== p.d.channel_id) {
        this.emit("playerMove", player, player.options.voiceID, p.d.channel_id)
        player.options.voiceID = p.d.channel_id
        if (!p.d.channel_id) {
          player.voiceState = PlayerVoiceStates.Disconnected
          player.pause(true)
        }
      }
    }

    if (
      ["op", "guildId", "event", "sessionId"].every(prop => prop in voice)
    ) void player.node.send(voice)
  }

  /** Create a player or return one if it already exists */
  public create(options: PlayerOptions): CoffeePlayer {
    return new CoffeePlayer(this, options)
  }

  /** Return a player or undefined if it doesn't exist */
  public get(guildID: string): CoffeePlayer | undefined {
    return this.players.get(guildID)
  }

  /** Destroy a player if it exist */
  public destroy(guildID: string): void {
    const player = this.get(guildID)
    if (player) player.destroy()
  }

  /** Add a node */
  public add(nodeOptions: NodeOptions): void {
    const node = new CoffeeNode(this, nodeOptions)

    node.on("event", payload => this.handleEvent(node, payload))
    node.on("connect", () => this.emit("nodeConnect", node))
    node.on("reconnect", () => this.emit("nodeReconnect", node))
    node.on("raw", payload => this.emit("nodeRaw", node, payload))
    node.on("error", error => this.emit("nodeError", node, error))
    node.on("destroy", () => {
      this.emit("nodeDestroy", node)
      this.nodes.delete(node.options.name)
    })
    node.on("disconnect", reason => {
      this.emit("nodeDisconnect", node, reason)
      if (this.options.autoReplay) {
        for (const player of this.players.values()) {
          if (player.options.node === node.options.name) {
            try {
              player.setNode(this.leastLoadNode!.options.name)
            } catch (error) {
              this.emit("replayError", player, error)
            }
          }
        }
      }
    })
    node.on("playerUpdate", (guildID, state) => {
      const player = this.players.get(guildID)
      if (!player) return
      player.position = state.position
    })

    if (this.clientID) node.connect()
  }

  private handleEvent(node: CoffeeNode, event: EventPayloads): void {
    if (!event.guildId) return

    const player = this.get(event.guildId)
    if (!player) return

    const track = player.queue.current!
    const type = event.type

    switch (type) {
      case EventTypes.TrackStart:
        {
          player.state = PlayerStates.Playing
          if (player.replaying) {
            player.replaying = false
            return
          }
          this.emit("trackStart", player, track, event as TrackStartPayload)
          if (!player.queue.previous) this.emit("queueStart", player, track, event as TrackStartPayload)
        }
        break
      case EventTypes.TrackEnd:
        {
          this.emit("trackEnd", player, track, event as TrackEndPayload)
          if (!player.queue.length && player.loop === LoopMode.None) {
            this.emit("queueEnd", player, track, event as TrackEndPayload)
          }
          if (this.options.autoPlay) void player.play({})
        }
        break
      case EventTypes.TrackStuck:
        {
          this.emit("trackStuck", player, track, event as TrackStuckPayload)
          if (!player.queue.length && player.loop === LoopMode.None) {
            this.emit("queueEnd", player, track, event as TrackEndPayload)
          }
          if (this.options.autoPlay) void player.play({})
        }
        break
      case EventTypes.TrackException:
        {
          // Replay
          if ((event as TrackExceptionPayload).exception.message === "The track was unexpectedly terminated.") return
          this.emit("trackError", player, track, event as TrackExceptionPayload)
          if (!player.queue.length && player.loop === LoopMode.None) {
            this.emit("queueEnd", player, track, event as TrackEndPayload)
          }
          if (this.options.autoPlay) void player.play({})
        }
        break
      case EventTypes.WebSocketClosed:
        if (this.options.autoResume && player.voiceState === PlayerVoiceStates.Connected) {
          try {
            player.connect()
          // eslint-disable-next-line no-empty
          } catch {}
        }
        this.emit("socketClosed", player, event as WebSocketClosedPayload)
        break
      default:
        this.emit("nodeError", node, new Error(`Node#event unknown event type '${type as string}'`))
    }
  }

  private sortAndGetFirstNode(sortFunc: (left: CoffeeNode, right: CoffeeNode) => number): CoffeeNode | undefined {
    const nodes = new Map<string, CoffeeNode>()

    for (const [id, node] of this.nodes.entries()) {
      if (node.connected) nodes.set(id, node)
    }

    const entries = [...nodes.entries()]
    entries.sort(([,a], [,b]) => sortFunc(a, b))

    nodes.clear()

    for (const [id, node] of entries) {
      nodes.set(id, node)
    }

    return nodes.values().next().value
  }
}
