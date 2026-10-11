# ArchAI skills for AI agents

Each folder is a skill: a `SKILL.md` (front matter `name` and `description`, then instructions)
plus any helper files. Claude Code loads them automatically in this repository; to use them
elsewhere, copy a folder into `~/.claude/skills/` (or your agent's skills folder), or give the
`SKILL.md` to any agent as instructions.

| Skill | Use it when |
|---|---|
| [archai-tools](archai-tools/SKILL.md) | An agent operates the ArchAI app (web or desktop window) through its command bus, `window.__archai`. |
| [archai-architect](archai-architect/SKILL.md) | An agent designs a building in ArchAI (on top of archai-tools). |
| [archai-live-bridge](archai-live-bridge/SKILL.md) | A script or agent sends 3D geometry into the ArchAI desktop app, or reads its model as glTF, over the Live Bridge (`archai_bridge.py`). |

archai-live-bridge's `archai_bridge.py` imports `plugins/python/archai_core.py` from this repo;
outside the repo set `ARCHAI_CORE` to a folder holding that file.
