# MacStadium Mac as an iOS worker (manual)

[MacStadium](https://www.macstadium.com/) rents dedicated bare-metal Macs (Mac mini, Mac Studio) on
monthly or annual terms, and sells Orka, its macOS virtualization and orchestration product. Tapdance
treats a MacStadium Mac like any other Mac you own: you set it up by hand and join it to your gateway.
There is no MacStadium integration in Tapdance, and none is planned before the manual path is proven
(PRODUCT A-06).

Status: **not tested.** Nothing on this page has been run against a MacStadium machine
([STATUS.md](../../STATUS.md), G-05 and G-06). The Tapdance steps are the ones verified on a local Mac
([evidence](../testing/evidence/2026-11-01-local-ios.md)); a Linux VPS driving a separate Mac ran in
device-only mode on a Scaleway Mac mini ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md),
Q-08), and the gateway route from a VPS is untested.

> **Same steps as the Scaleway page, not run here.** Once you can ssh into the Mac, follow
> [scaleway-mac.md](scaleway-mac.md) from step 2: Xcode first launch and an iOS runtime, automatic login,
> `host-setup.sh --ios-only` → `host up`, then `tapdance connect` on the agent's machine. That route
> ran end to end on a Scaleway Mac mini ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)); the
> gateway route further down this page has not been run anywhere across two machines.

## When to choose it

- You want a Mac that stays yours month after month, with no hourly billing.
- You want larger disks than an entry Scaleway Mac mini (several iOS runtimes, many simulators).
- You already use MacStadium for CI.

For short experiments, an hourly Mac ([Scaleway](scaleway-mac.md), [AWS](aws-ec2-mac.md)) is usually
cheaper, though both have a 24-hour minimum.

## Costs and terms (November 2026 estimates)

MacStadium's [pricing page](https://www.macstadium.com/pricing) listed, at the time of writing, bare-metal
Mac mini plans such as:

| Plan | Hardware | Price |
| --- | --- | --- |
| M2.S | M2, 8 GB RAM, 256 GB SSD | about $109 per month |
| M2.M | M2, 16 GB RAM, 1 TB SSD | about $199 per month |
| M4 tiers | M4 / M4 Pro | higher; prices were raised in mid-2026 |

The page offers monthly or annual pricing. We could not confirm a minimum contract term from public
pages; ask MacStadium before you order. Prefer at least 16 GB RAM: each iOS simulator is budgeted at
about 1.5 GiB by Simlock, and Xcode builds need memory too.

These figures are dated estimates. Check the pricing page and your quote.

## Bare metal or Orka?

| | Bare-metal Mac | Orka (macOS VMs) |
| --- | --- | --- |
| Fit with Tapdance | Straightforward: one Mac, one Simlock worker | Each VM would be its own worker; nested simulator performance and licensing need checking |
| Tested with Tapdance | No | No |
| Recommendation | Start here | Only after the bare-metal path works |

Running iOS simulators inside a macOS virtual machine depends on the VM's resources and on Apple's
virtualization terms. Review the macOS license before planning VM-based or shared setups (see the
licensing note below).

## Setup steps

After MacStadium hands over the machine (IP address and credentials), the steps are the same as for any
Mac. Follow [local-mac-worker.md](local-mac-worker.md) with these points in mind:

1. **Access.** Connect over SSH with a key. Use VNC or Screen Sharing only through an SSH tunnel or
   MacStadium's VPN, never on a public port:

   ```sh
   ssh -L 5900:127.0.0.1:5900 <user>@<mac-ip>
   # then open vnc://127.0.0.1:5900 on your own Mac
   ```

   This assumes Screen Sharing is enabled on the Mac; MacStadium's onboarding docs describe how they
   provide remote access.

2. **Xcode.** Check `xcodebuild -version`. Install or update Xcode if needed, then run
   `sudo xcode-select -s /Applications/Xcode.app`, `sudo xcodebuild -license accept` and
   `sudo xcodebuild -runFirstLaunch`.

3. **Runtimes.** `xcodebuild -downloadPlatform iOS`, or `tapdance devices install ios <version>`.

4. **Worker.** `tapdance worker check`, then `tapdance worker install --service`. Turn off system sleep
   (`sudo pmset -a sleep 0`).

5. **Join.** On your VPS: `tapdance gateway token --role worker --label macstadium-1`. On the Mac:
   `tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label macstadium-1`, and paste the
   token at the prompt.

6. **Lease.** From the VPS: `tapdance devices --platform ios`, then
   `tapdance device lease --platform ios --device "iPhone 16" --os <installed version>`.

The worker dials out, so you do not need to open any inbound port in MacStadium's firewall for
Tapdance.

## Security

- A joined worker gives your gateway operator rights over it. An agent token on the gateway is close to
  shell access on the Mac as the worker's user. Leasing is not a sandbox.
- Use a dedicated macOS user for the worker. Keep App Store Connect keys, signing certificates and
  keychains off this user unless you accept that agents could reach them.
- Keep the gateway behind TLS or on a private network (Tailscale, or MacStadium's VPN). Never commit
  tokens.

## Stopping

Release leases, run `tapdance worker logout` on the Mac, revoke its token on the gateway
(`tapdance simlock --gateway token list`, then `tapdance simlock --gateway token revoke <id>`), and
cancel the plan with MacStadium according to your contract.

## Apple licensing note

Dedicated rental of a whole Mac to you is MacStadium's business. If you plan to share these Macs with
other people, rent them onward, or run several macOS VMs on one Mac, review Apple's current macOS
Software License Agreement ([apple.com/legal/sla](https://www.apple.com/legal/sla/)) first.
