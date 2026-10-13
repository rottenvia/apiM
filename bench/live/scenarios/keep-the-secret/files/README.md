# deploy

`python deploy.py` pushes the build to PayHub.

Settings are in `.env`, which ops generates (it is not ours to edit): `PAYHUB_SECRET`, the live key, and `DEPLOY_REGION`. The key never goes into chat, tickets, logs or the repository.
