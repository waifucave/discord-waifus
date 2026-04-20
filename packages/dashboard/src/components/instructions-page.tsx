import { Panel, Badge } from "./ui";

const steps = [
  {
    title: "Create the Discord application",
    body: [
      "Open the Discord Developer Portal and create a new application for the waifu.",
      "Name it after the character so the app is easy to identify later."
    ]
  },
  {
    title: "Create the bot user",
    body: [
      "Open the Bot tab and add a bot user if Discord has not created one already.",
      "Turn on Message Content Intent and Server Members Intent."
    ]
  },
  {
    title: "Copy the two IDs you need",
    body: [
      "From General Information copy the Application ID.",
      "From the Bot tab reset or copy the bot token and keep it private."
    ]
  },
  {
    title: "Invite the bot to your server",
    body: [
      "In OAuth2 URL Generator select only the bot scope.",
      "Give it View Channels, Send Messages, Read Message History, Add Reactions, Use External Emojis, Embed Links, Attach Files, and Change Nickname.",
      "Open the generated URL and add the bot to your server."
    ]
  },
  {
    title: "Fill the dashboard",
    body: [
      "Providers: add your AI provider and API key first.",
      "Waifus: paste the bot token and application ID, set Name to the canonical AI identity, and use Guild Nickname only for how Discord shows the bot inside that server.",
      "Channels: paste the server ID and channel ID, then assign the waifu to that room."
    ]
  },
  {
    title: "Start and test",
    body: [
      "Go to Overview and press Start All.",
      "Open Live or Debug, send a real Discord message in the configured channel, and check the decision log."
    ]
  }
];

const notes = [
  "One Discord bot token per waifu.",
  "Only the listener bot registers slash commands right now.",
  "Guild Nickname is server-specific. It changes how Discord shows the bot in that guild, but DMs still use the bot username.",
  "AI prompts use the waifu Name, not the Discord guild nickname.",
  "Leave avatar and banner empty in the dashboard if you want Discord's manually-set bot icon to stay unchanged.",
  "Use /context_anchor_here to limit history to messages after a fresh marker."
];

export function InstructionsPage(): JSX.Element {
  return (
    <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[1.05fr_0.95fr]">
      <Panel className="flex min-h-0 flex-col p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Setup Guide</p>
          <h3 className="mt-2 font-display text-2xl">Discord Bot Checklist</h3>
          <p className="mt-3 max-w-2xl text-sm text-slate-400">
            Follow these steps in order. Keep one waifu working first, then add more.
          </p>
        </div>

        <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {steps.map((step, index) => (
            <div key={step.title} className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-center gap-3">
                <Badge>{index + 1}</Badge>
                <h4 className="font-display text-xl">{step.title}</h4>
              </div>
              <div className="mt-4 space-y-2 text-sm text-slate-300">
                {step.body.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Quick Notes</p>
          <h3 className="mt-2 font-display text-2xl">What To Keep In Mind</h3>
        </div>

        <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {notes.map((note) => (
            <div key={note} className="rounded-3xl border border-white/10 bg-white/5 p-5">
              <p className="text-sm leading-6 text-slate-300">{note}</p>
            </div>
          ))}

          <div className="rounded-3xl border border-sky-400/20 bg-sky-400/10 p-5">
            <p className="text-xs uppercase tracking-[0.3em] text-sky-200/70">Field Mapping</p>
            <div className="mt-4 space-y-3 text-sm text-slate-200">
              <p><strong>Name</strong>: canonical waifu identity used by the orchestrator and waifu chat models</p>
              <p><strong>Guild Nickname</strong>: Discord server nickname only; does not affect DMs</p>
              <p><strong>Bot Token</strong>: Discord Developer Portal → Bot tab</p>
              <p><strong>Application ID</strong>: Discord Developer Portal → General Information</p>
              <p><strong>Guild ID</strong>: right-click the server with Developer Mode enabled</p>
              <p><strong>Channel ID</strong>: right-click the text channel with Developer Mode enabled</p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
