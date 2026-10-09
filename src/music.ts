import {
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type VoiceBasedChannel,
} from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { inviteUrl, isDiscordCode } from "./discord.ts";
import { errorMessage, log } from "./log.ts";
import { ALLOWED_HOSTS, createQueue, describe, formatDuration, parseRequest, type Track } from "./tracks.ts";
import { FetchError, lookupFor, startFetch, toPlayback, type Fetching, type Playback } from "./ytdlp.ts";

/**
 * Music (the owner, 2026-10-08): slash commands in the commands channel only. /play takes a
 * link to one of the sites tracks.ts lists (a Spotify link is looked up by name) or words
 * to search YouTube for, joins the voice channel of whoever asked, and plays, or queues
 * when something is playing; /skip, /previous, /pause, /resume, /stop and /queue do what
 * they say. One voice channel at a time. The bot leaves after five minutes with nothing to
 * play, when the last listener leaves, and on /stop. Fetching and converting is ytdlp.ts;
 * the queue and the words are tracks.ts. The bot keeps only the queue, in memory, while it
 * plays.
 */

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song, or add it to the queue")
    .addStringOption((option) =>
      option.setName("song").setDescription("A link (YouTube, SoundCloud, Spotify, ...) or words to search for").setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Skip to the next song"),
  new SlashCommandBuilder().setName("previous").setDescription("Back to the song before"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause"),
  new SlashCommandBuilder().setName("resume").setDescription("Carry on"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop, forget the queue and leave the voice channel"),
  new SlashCommandBuilder().setName("queue").setDescription("What is playing, and what comes next"),
].map((command) => command.toJSON());

/** After the last song, how long the bot stays in the voice channel. */
const LINGER_MS = 5 * 60_000;
const JOIN_TIMEOUT_MS = 20_000;
const SHOWN_UPCOMING = 10;
const NO_PINGS = { parse: [] as never[] };
const SITES = ALLOWED_HOSTS.filter((host) => host !== "youtu.be" && host !== "open.spotify.com")
  .map((host) => host.replace(/\.com$/, ""))
  .join(", ");

/**
 * The bot's slash commands, put in the server (there at once, unlike global ones). False
 * when the bot was invited without the scope for commands; the log says how to fix that.
 */
export async function registerCommands(client: Client<true>, guildId: string): Promise<boolean> {
  try {
    await client.application.commands.set(COMMANDS, guildId);
    return true;
  } catch (error) {
    if (!isDiscordCode(error, RESTJSONErrorCodes.MissingAccess)) throw error;
    log.warn(
      "music is off: the bot cannot add its slash commands, because it was invited without the " +
        `applications.commands scope. Open this link once, pick the server, then start the bot again: ${inviteUrl(client.application.id)}`,
    );
    return false;
  }
}

/** The bot's slash commands taken out of the server again, so none is left with no one answering it. */
export async function clearCommands(client: Client<true>, guildId: string): Promise<void> {
  try {
    await client.application.commands.set([], guildId);
  } catch (error) {
    if (!isDiscordCode(error, RESTJSONErrorCodes.MissingAccess)) log.warn(`could not remove the slash commands: ${errorMessage(error)}`);
  }
}

/** A reason to say no, in the asker's own terms. */
class Refusal extends Error {
  override name = "Refusal";
}

export type Music = {
  handle(interaction: ChatInputCommandInteraction): Promise<void>;
  /** A voice channel just lost its last listener. */
  emptied(channelId: string): void;
  shutdown(): void;
};

export function createMusic(guild: Guild, channelId: string): Music {
  const queue = createQueue<Track>();
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  let connection: VoiceConnection | undefined;
  /** The song being fetched, before its audio has started. */
  let pending: Fetching | undefined;
  /** The song's audio, once it plays. */
  let playback: Playback | undefined;
  let playing: Track | undefined;
  let lingering: NodeJS.Timeout | undefined;
  /** Counts each start of a song, so a start overtaken by a skip or a stop knows to give up. */
  let generation = 0;
  /** While the bot is leaving, the player going idle means nothing. */
  let leaving = false;
  /** Joins happen one after another, so two at once cannot pull the bot two ways. */
  let joins: Promise<void> = Promise.resolve();

  const live = (candidate: VoiceConnection | undefined): candidate is VoiceConnection =>
    candidate !== undefined && candidate.state.status !== VoiceConnectionStatus.Destroyed;

  const stopPlayback = () => {
    generation++;
    pending?.close();
    pending = undefined;
    playback?.close();
    playback = undefined;
    playing = undefined;
  };

  const dropConnection = () => {
    const old = connection;
    connection = undefined;
    if (live(old)) old.destroy();
  };

  /** Out of the voice channel, with nothing kept. */
  const leave = () => {
    clearTimeout(lingering);
    queue.clear();
    leaving = true;
    try {
      stopPlayback();
      player.stop(true);
    } finally {
      leaving = false;
    }
    dropConnection();
  };

  /** The next song, or five minutes of quiet and then out. */
  const advance = () => {
    const next = queue.next();
    if (next) {
      void play(next);
      return;
    }
    clearTimeout(lingering);
    lingering = setTimeout(() => {
      if (player.state.status === AudioPlayerStatus.Idle && !pending) {
        log.info("music: nothing more to play; left the voice channel");
        leave();
      }
    }, LINGER_MS);
  };

  /** Plays a song: the fetch already started for it, or a fresh one. */
  async function play(track: Track, fetching?: Fetching): Promise<void> {
    clearTimeout(lingering);
    stopPlayback();
    const mine = generation;
    const fetch = fetching ?? startFetch({ kind: "url", url: track.url }, track.requestedBy);
    pending = fetch;
    playing = track;
    let found: Track;
    try {
      found = await fetch.info;
    } catch (error) {
      if (mine !== generation) return;
      pending = undefined;
      playing = undefined;
      fetch.close();
      log.warn(`music: could not play "${track.title}": ${errorMessage(error)}`);
      advance();
      return;
    }
    if (mine !== generation) {
      fetch.close();
      return;
    }
    pending = undefined;
    playback = toPlayback(fetch, found.format);
    player.play(createAudioResource(playback.stream, { inputType: playback.type }));
    log.info(`music: playing "${track.title}" (${formatDuration(track.duration)}) for ${track.requestedBy}`);
  }

  player.on(AudioPlayerStatus.Idle, () => {
    // A song still being fetched: the idle state is the gap before it, not the end of anything.
    if (leaving || pending) return;
    stopPlayback();
    advance();
  });
  player.on("error", (error) => {
    // The player goes idle after this, and the next song follows.
    log.error(`music: playing "${playing?.title ?? "?"}" failed: ${error.message}`);
  });

  /** On to the next song, whether the current one is playing or still being fetched. */
  const skip = () => {
    if (pending) {
      stopPlayback();
      advance();
    } else {
      // Forced: a paused player would otherwise sit on the skipped song until resumed.
      player.stop(true);
    }
  };

  async function doJoin(channel: VoiceBasedChannel): Promise<void> {
    if (live(connection) && connection.joinConfig.channelId === channel.id) return;
    if (live(connection) && playing) throw new Refusal(`I'm playing in <#${connection.joinConfig.channelId}>; join me there`);
    dropConnection();
    const fresh = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    connection = fresh;
    fresh.on(VoiceConnectionStatus.Disconnected, () => {
      // Moved, kicked, or a short drop: a moment to come back, else let go.
      Promise.race([
        entersState(fresh, VoiceConnectionStatus.Signalling, 5_000),
        entersState(fresh, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection !== fresh) return;
        log.info("music: the voice connection was lost; stopped");
        leave();
      });
    });
    fresh.on("error", (error) => log.error(`music: voice connection: ${error.message}`));
    fresh.subscribe(player);
    try {
      await entersState(fresh, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
    } catch (error) {
      if (live(fresh)) fresh.destroy();
      if (connection === fresh) connection = undefined;
      throw new Refusal(`I could not join <#${channel.id}> (${errorMessage(error)})`);
    }
  }

  const join = (channel: VoiceBasedChannel) => {
    const attempt = joins.catch(() => {}).then(() => doJoin(channel));
    joins = attempt;
    return attempt;
  };

  /** The reply to a command, whether or not it was deferred; a whisper only before a deferral. */
  const answer = (interaction: ChatInputCommandInteraction, content: string, whisper = false) =>
    interaction.deferred || interaction.replied
      ? interaction.editReply({ content, allowedMentions: NO_PINGS })
      : interaction.reply({ content, allowedMentions: NO_PINGS, ...(whisper ? { flags: MessageFlags.Ephemeral } : {}) });

  /** The voice channel the member is in, if the bot may play there; else a whispered reason and undefined. */
  async function theirChannel(interaction: ChatInputCommandInteraction<"cached">): Promise<VoiceBasedChannel | undefined> {
    const voice = interaction.member.voice.channel;
    if (!voice) {
      await answer(interaction, "Join a voice channel first.", true);
      return undefined;
    }
    if (live(connection) && connection.joinConfig.channelId !== voice.id && playing) {
      await answer(interaction, `I'm playing in <#${connection.joinConfig.channelId}>; join me there.`, true);
      return undefined;
    }
    const me = await guild.members.fetchMe();
    if (!voice.permissionsFor(me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      await answer(interaction, `I need Connect and Speak in <#${voice.id}>.`, true);
      return undefined;
    }
    return voice;
  }

  async function onPlay(interaction: ChatInputCommandInteraction<"cached">) {
    const request = parseRequest(interaction.options.getString("song", true));
    if (!request) {
      await answer(interaction, "Give me a link, or words to search for.", true);
      return;
    }
    if (request.kind === "other-link") {
      await answer(interaction, `I only take links from ${SITES} and Spotify; for anything else, search by name.`, true);
      return;
    }
    const voice = await theirChannel(interaction);
    if (!voice) return;
    await interaction.deferReply();
    const fetching = startFetch(await lookupFor(request), interaction.user.id);
    let track: Track;
    try {
      track = await fetching.info;
      await join(voice);
    } catch (error) {
      fetching.close();
      throw error;
    }
    const ahead = queue.add(track);
    if (ahead === 0 && !playing) {
      void play(track, fetching);
      await answer(interaction, `Now playing ${describe(track)}`);
    } else {
      // Its turn comes later; it is fetched again then.
      fetching.close();
      await answer(interaction, `Queued ${describe(track)}, ${ahead} ahead`);
    }
  }

  async function onSkip(interaction: ChatInputCommandInteraction<"cached">) {
    const skipped = playing;
    if (!skipped) {
      await answer(interaction, "Nothing is playing.", true);
      return;
    }
    skip();
    await answer(interaction, `Skipped ${describe(skipped)}`);
  }

  async function onPrevious(interaction: ChatInputCommandInteraction<"cached">) {
    if (!queue.hasPrevious()) {
      await answer(interaction, "Nothing to go back to.", true);
      return;
    }
    const voice = await theirChannel(interaction);
    if (!voice) return;
    await interaction.deferReply();
    await join(voice);
    const track = queue.previous();
    if (!track) {
      await answer(interaction, "Nothing to go back to.");
      return;
    }
    void play(track);
    await answer(interaction, `Playing ${describe(track)} again`);
  }

  async function onPause(interaction: ChatInputCommandInteraction<"cached">) {
    if (!playing || !player.pause()) {
      await answer(interaction, pending ? "Still fetching it; a moment." : "Nothing is playing.", true);
      return;
    }
    await answer(interaction, `Paused ${describe(playing)}`);
  }

  async function onResume(interaction: ChatInputCommandInteraction<"cached">) {
    if (!playing || !player.unpause()) {
      await answer(interaction, "Nothing is paused.", true);
      return;
    }
    await answer(interaction, `Playing ${describe(playing)}`);
  }

  async function onStop(interaction: ChatInputCommandInteraction<"cached">) {
    const wasPlaying = Boolean(playing || live(connection));
    leave();
    await answer(interaction, wasPlaying ? "Stopped, and left the voice channel." : "Nothing was playing.", !wasPlaying);
  }

  async function onQueue(interaction: ChatInputCommandInteraction<"cached">) {
    const lines: string[] = [];
    if (playing) lines.push(`${pending ? "Fetching" : "Now"}: ${describe(playing)}`);
    const upcoming = queue.upcoming();
    upcoming.slice(0, SHOWN_UPCOMING).forEach((track, index) => lines.push(`${index + 1}. ${describe(track)}`));
    if (upcoming.length > SHOWN_UPCOMING) lines.push(`… and ${upcoming.length - SHOWN_UPCOMING} more`);
    await answer(interaction, lines.length > 0 ? lines.join("\n") : "Nothing is queued.", lines.length === 0);
  }

  return {
    async handle(interaction) {
      // How late the command is already when it gets here: Discord allows three seconds in all.
      const age = Date.now() - interaction.createdTimestamp;
      log.info(`music: /${interaction.commandName} received ${age} ms after it was sent (connection latency ${interaction.client.ws.ping} ms)`);
      if (interaction.channelId !== channelId) {
        await answer(interaction, `Music commands work in <#${channelId}>.`, true);
        return;
      }
      if (!interaction.inCachedGuild()) return;
      try {
        switch (interaction.commandName) {
          case "play":
            return await onPlay(interaction);
          case "skip":
            return await onSkip(interaction);
          case "previous":
            return await onPrevious(interaction);
          case "pause":
            return await onPause(interaction);
          case "resume":
            return await onResume(interaction);
          case "stop":
            return await onStop(interaction);
          case "queue":
            return await onQueue(interaction);
          default:
            return;
        }
      } catch (error) {
        if (isDiscordCode(error, RESTJSONErrorCodes.UnknownInteraction)) {
          // Discord allows three seconds for a first answer, and it had refused this one by the
          // time the answer arrived; the member was already told the application did not respond.
          log.warn(
            `music: /${interaction.commandName} was refused by Discord as too late: it was ${age} ms old when it got here ` +
              `and ${Date.now() - interaction.createdTimestamp} ms old when the answer reached Discord; nothing was done`,
          );
          return;
        }
        const expected = error instanceof FetchError || error instanceof Refusal;
        if (!expected) log.error(`music: /${interaction.commandName} failed: ${errorMessage(error)}`);
        const reason = expected ? error.message : `something went wrong (${errorMessage(error)})`;
        await answer(interaction, `Sorry, ${reason}.`).catch(() => {});
      }
    },

    emptied(voiceChannelId) {
      if (!live(connection) || connection.joinConfig.channelId !== voiceChannelId) return;
      if (!playing && queue.upcoming().length === 0) return;
      log.info("music: everyone left the voice channel; stopped");
      leave();
    },

    shutdown: leave,
  };
}
