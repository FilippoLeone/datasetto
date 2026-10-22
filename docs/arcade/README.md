# Arcade design documents

The design for replacing the old minigames with the Arcade: one shared game platform and four games.
These documents were written before implementation and are the reference for the work packages.
platform.md §20 records how the platform was built where it differs from the plan.

| Document | What it covers |
|---|---|
| [plan.md](plan.md) | Work packages, file ownership, interfaces, acceptance criteria, verification and PR plan |
| [platform.md](platform.md) | The platform: transport lanes, pacing, shared core, server host, wallet, client runtime, offline mode; §20 as built |
| [building-a-game.md](building-a-game.md) | For the game packages: the files you own, what to import from where, the lifecycle the platform drives, test helpers |
| [lamplight.md](lamplight.md) | Lamplight Hold'em: poker with cash tables, the Lamplight Cup and the Firefly Trio |
| [glimmerhall.md](glimmerhall.md) | Glimmerhall: slot machines, the Glimmer Pot and Glimmer Dash |
| [fuseyard.md](fuseyard.md) | Fuseyard: the grid bomb arena |
| [bellwick.md](bellwick.md) | Bellwick: The Silent Bells, the top-down adventure |

Everything here uses virtual chips and credits only. Nothing can be bought, sold or cashed out.
