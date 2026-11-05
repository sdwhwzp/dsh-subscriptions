# Harness compatibility

## Harness 0.2.2-rc.1

Version `0.7.68-dsh.20261104.1` uses the Harness 0.2.2-rc.1 compiler packages and Cordis 4.1.0. Account deployments keep this optional plugin disabled. If enabled alongside the standard subscription plugin, set `namespacedRoutes: true` to retain the durable `subscriptions-<vendor>` model routes. The standard plugin owns shared slash commands. Management requests suppress the public page referrer for authenticated gateway compatibility. Chinese settings copy ships in the upstream lazy locale chunk.

The public upstream tree omits `test/_setup.mjs` and `scripts/check-pack-size.mjs`, although its test command references both. This fork retains its runnable lint, typecheck and Node test command. The unavailable upstream coverage/pack-size gate is not claimed as passing.

## Harness 0.2.2-alpha.2

Version `0.7.23-dsh.20261028.2` admits the Harness 0.2.2-alpha.2 and matching Cordis package cohort. Existing account authorization, data roots and plugin configuration are retained. Runtime acceptance is recorded separately from source and artifact checks.
