# T3 + Rebound merged bot (flat layout)

Every file sits in one flat folder (no subfolders) so it's easy to upload
from mobile. Runs the **T3 Scrims** bot and the **Rebound BGMI** bot as one
process on a single Discord bot token.

## Setup

1. Upload every `.js` file plus `package.json` and `.env.example` into one
   folder on your host.
2. Rename `.env.example` to `.env` and fill in `DISCORD_TOKEN` and
   `CLIENT_ID` at minimum.
3. `npm install`
4. `npm start`

Slash commands auto-register on startup and whenever the bot joins a new
server — no separate deploy step needed.

## Files that were renamed to avoid clashes

The two original bots shared several filenames with different code
inside, plus a few identical command names/IDs. Only the **T3** side was
renamed (Rebound is the bigger, more actively developed bot, so its
names were kept):

| Kind | Original (T3) | Renamed to |
|---|---|---|
| File | `storage.js` | `t3-storage.js` |
| File | `group-schedule.js` | `t3-group-schedule.js` |
| File | `group-schedule-handlers.js` | `t3-group-schedule-handlers.js` |
| File | `group-channel-access.js` | `t3-group-channel-access.js` |
| File | `live-panel-handlers.js` | `t3-live-panel-handlers.js` |
| File | `pending-registrations.js` | `t3-pending-registrations.js` |
| File | `punish-handlers.js` | `t3-punish-handlers.js` |
| File | `registration-handlers.js` | `t3-registration-handlers.js` |
| File | `registration-modals.js` | `t3-registration-modals.js` |
| File | `admin-panel-handlers.js` | `t3-admin-panel-handlers.js` |
| File + slash command | `cmd-admin-panel.js` (`/admin-panel`) | `cmd-t3-admin-panel.js` (`/t3-admin-panel`) |
| File + slash command | `cmd-remove-registration.js` (`/remove-registration`) | `cmd-t3-remove-registration.js` (`/t3-remove-registration`) |
| File + prefix command | `pcmd-open.js` (`!open`) | `pcmd-t3-open.js` (`!t3open`) |
| File + prefix command | `pcmd-team.js` (`!team`, alias `!viewteam`) | `pcmd-t3-team.js` (`!t3team`, alias `!t3viewteam`) |
| Button/select ID | `group_schedule_select` | `t3_group_schedule_select` |
| Modal ID | `group_schedule_modal:*` | `t3_group_schedule_modal:*` |

Every other file, command, and interaction ID in both bots was checked
and confirmed **not** to collide, so it was left exactly as it was.

## Data storage

Both bots write their own local JSON file: T3 now writes to
`t3-data.json`, Rebound writes to `data.json`. They no longer overwrite
each other now that they live in the same folder. If you set `DATA_DIR`
in `.env` to point at a shared persistent volume, both bots will write
their (differently-named) files there — still no collision.

## Adding features later

Keep any new file/command/ID names unique against everything already in
this folder. `index.js` throws a startup error if two loaded slash or
prefix commands end up with the same name, so a real collision fails
loudly instead of silently overwriting a command.
