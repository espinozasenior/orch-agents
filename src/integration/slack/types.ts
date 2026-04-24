/**
 * Slack event payload types for webhook ingestion.
 */

export interface SlackEventPayload {
  type: 'url_verification' | 'event_callback';
  token?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackEvent;
}

export type SlackEvent = SlackAppMention | SlackMessage;

export interface SlackAppMention {
  type: 'app_mention';
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
}

export interface SlackMessage {
  type: 'message';
  subtype?: string;
  user: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
}
