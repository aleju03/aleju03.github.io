/*
  Types for the one server module the frontend build touches: vite.config.ts
  mounts this same handler on the dev server, so `npm run dev` has a working
  video search with no VITE_CHAT_URL and no separate process. Everything else
  in server/ is plain JS that only ever runs on the VPS.
*/
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface VideoResult {
  id: string
  title: string
  author: string
  length: string
  views: string
  thumb: string
}

/** pull the video rows out of a YouTube results page; never throws */
export function parseResults(html: string): VideoResult[]

export interface YouTubeSearchRoute {
  /** resolves true when this route answered the request */
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

export function createYouTubeSearch(options?: {
  allowedOrigins?: string[]
  enabled?: boolean
}): YouTubeSearchRoute | null
