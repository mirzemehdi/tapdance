# AWS EC2 Mac as an iOS worker (manual)

AWS runs macOS on real Apple hardware as EC2 Mac instances. Each one needs an EC2 **Dedicated Host**:
a whole Mac allocated to your account. This page sets one up by hand as a Tapdance worker.

Status: **not tested.** Nothing on this page has been run on AWS by the Tapdance maintainers
([STATUS.md](../../STATUS.md), G-05 and G-06). The Tapdance steps are the ones verified on a local Mac
([evidence](../testing/evidence/2026-11-01-local-ios.md)); a Linux VPS driving a separate Mac ran in
device-only mode on a Scaleway Mac mini ([evidence](../testing/evidence/2026-11-07-vps-rented-mac-ios.md),
Q-08), and the gateway route from a VPS is untested.
Tapdance has no AWS integration; `packages/` contains no cloud SDK.

> **Same steps as the Scaleway page, not run here.** Once you can ssh into the Mac, follow
> [scaleway-mac.md](scaleway-mac.md) from step 2: Xcode first launch and an iOS runtime, automatic login,
> `host-setup.sh --ios-only` → `host up`, then `tapdance connect` on the agent's machine. That route
> ran end to end on a Scaleway Mac mini ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)); the
> gateway route further down this page has not been run anywhere across two machines.

## Costs and terms (November 2026 estimates)

| Item | What AWS states | Source |
| --- | --- | --- |
| Minimum allocation | **24 hours** per Dedicated Host, to comply with Apple's macOS license. After 24 hours you can release the host at any time. | [EC2 Mac instances](https://aws.amazon.com/ec2/instance-types/mac/) |
| Billing | Per second after the 24-hour minimum. You pay for the **host** while it is allocated, whether or not an instance runs on it. | same |
| Pricing models | On-Demand Dedicated Hosts; Savings Plans (AWS quotes up to 44% off with a 3-year commitment) | same |
| Example price | `mac2-m2.metal` around **$0.88 per hour** On-Demand (third-party listing, region not stated), so the 24-hour minimum is roughly $21 | [Vantage listing](https://instances.vantage.sh/aws/ec2/mac2-m2.metal); confirm on [Dedicated Hosts pricing](https://aws.amazon.com/ec2/dedicated-hosts/pricing/) |

Prices vary by region and change. Use the AWS Pricing Calculator for your region before you allocate.

## Instance types

From the [EC2 Mac page](https://aws.amazon.com/ec2/instance-types/mac/) as read on 2026-11-01:

| Type | Chip | Memory | Notes |
| --- | --- | --- | --- |
| `mac2.metal` | M1 | 16 GB | Closest to the Mac Tapdance was tested on (M1 Pro, 16 GB) |
| `mac2-m2.metal` | M2 | 24 GB | A sensible first choice for a few simulators |
| `mac2-m2pro.metal` | M2 Pro | 32 GB | More simulators at once |
| `mac2-m1ultra.metal` | M1 Ultra | 128 GB | Large |
| `mac-m4.metal`, `mac-m4pro.metal`, `mac-m4max.metal`, `mac-m3ultra.metal` | M4 / M4 Pro / M4 Max / M3 Ultra | 24–256 GB | Newer; the M4 types need macOS 15.6 or later per AWS |
| `mac1.metal` | Intel | 32 GB | Intel; not tested with Simlock |

## Credentials: never in plain text

- Use AWS IAM Identity Center (`aws configure sso`) or another short-lived credential method for the
  AWS CLI. Do not create long-lived access keys for this, and never put AWS keys in a repository, a
  `tapdance.config.json`, a shell history or a chat with an agent.
- Do not give your coding agent AWS credentials. Tapdance never needs them: it only talks to the
  Simlock gateway.
- On the Mac itself, do not store AWS keys. If the instance needs AWS access, attach an IAM instance
  role with the smallest permissions it needs.

## 1. Allocate a Dedicated Host

In the EC2 console (Dedicated Hosts > Allocate) or with the AWS CLI:

```sh
aws ec2 allocate-hosts \
  --instance-type mac2-m2.metal \
  --availability-zone us-east-1a \
  --quantity 1
```

Note the returned `HostId`. The 24-hour minimum starts now. Not every zone has every Mac type; the
console shows which zones offer it.

## 2. Launch a macOS instance on the host

Pick a current macOS AMI from AWS (the console lists them under the Mac instance type). AWS's macOS AMIs
include the Command Line Tools for Xcode, Homebrew, the AWS CLI and the SSM Agent, but **not** the full
Xcode app ([AMI release notes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/macos-ami-overview.html)).
Give the root EBS volume room for Xcode and runtimes: AWS's own guidance notes that the 100 GB default is
not enough to download and install Xcode; 200 GB or more is a reasonable start.

```sh
aws ec2 run-instances \
  --image-id <macos-ami-id> \
  --instance-type mac2-m2.metal \
  --placement "HostId=<host-id>" \
  --key-name <your-key-pair> \
  --security-group-ids <sg-id> \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3}'
```

Check the root device name of your AMI before you copy the mapping.

Security group: the worker needs **no inbound rule** for Tapdance, because it dials out to the gateway.
Allow SSH only from your own IP, or use SSM Session Manager and allow no inbound traffic at all.

## 3. Connect

```sh
ssh -i <key.pem> ec2-user@<public-dns>
```

For the desktop (needed for some Xcode installs and to check the simulator in a logged-in session),
AWS documents enabling Screen Sharing and connecting through an SSH tunnel
([AWS guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-to-mac-instance.html)). On the
instance:

```sh
sudo passwd ec2-user
sudo launchctl enable system/com.apple.screensharing
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist
```

Then, from your own computer:

```sh
ssh -i <key.pem> -L 5900:localhost:5900 ec2-user@<public-dns>
# open vnc://localhost:5900 on your own Mac
```

Never open port 5900 in the security group.

On macOS Sequoia and later, AWS asks you to approve the Local Network Privacy prompt once in the GUI;
see the AMI release notes.

## 4. Install Xcode and a runtime

Install Xcode from the App Store over Screen Sharing, or download the `.xip` from
[developer.apple.com/download](https://developer.apple.com/download/) (Apple ID required). Then:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
```

Do not store your Apple ID password on the instance. Sign out of the App Store when Xcode is installed.

## 5. Install the worker and join the gateway

Install Node.js 22.13 or later (`brew install node` works on AWS AMIs, which ship Homebrew; check the
version), then the Tapdance CLI as in [local-mac-worker.md](local-mac-worker.md#3-install-tapdance-and-check-the-mac).

```sh
tapdance worker check
tapdance worker install --service
sudo pmset -a sleep 0
```

On your gateway VPS: `tapdance gateway token --role worker --label aws-mac-1`. On the Mac:

```sh
tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label aws-mac-1
```

Paste the token at the prompt. Then on the VPS: `tapdance workers list` and
`tapdance devices --platform ios`, and lease as in [scaleway-mac.md](scaleway-mac.md#5-connect-the-agents-machine).

The worker runs as a launchd login service, so it starts when `ec2-user` is logged in. Whether simulator
boot and screen capture work without a logged-in desktop session has not been tested.

**Security:** the gateway gets operator rights over this worker, and an agent token on the gateway is
close to shell access as `ec2-user`. If the instance has an IAM role, an agent could reach whatever
that role can. Give the instance no role, or a role with nothing in it that you would not hand to the
agent.

## 6. Stop paying

1. Release leases, run `tapdance worker logout` on the Mac, and revoke the join token on the gateway
   (`tapdance simlock --gateway token list`, then `tapdance simlock --gateway token revoke <id>`).
2. Terminate the instance. Stopping it is not enough: the host keeps billing.
3. Release the host after the 24-hour minimum:

   ```sh
   aws ec2 release-hosts --host-ids <host-id>
   ```

After an instance terminates, AWS scrubs the Mac before the host is usable or releasable again, and
this can take a while. Check the host's state in the console and release it when AWS allows.

## Future: provisioning integration

PRODUCT A-06 allows a machine-provider abstraction (create, provision, start, stop, health, connect,
remove) for Mac hosts. It is deliberately not started (STATUS A-06): manual setup comes first. If it is
built, it must take AWS credentials from the standard AWS credential chain (SSO, instance roles), never
from Tapdance config or MCP, and it must respect the 24-hour host minimum when it releases hosts.

## Apple licensing note

AWS's 24-hour minimum comes from Apple's macOS Software License Agreement. Using a host for your own
testing is what AWS sells. Sharing hosts with other people, re-renting them, or offering short sessions
needs a review of the current license ([apple.com/legal/sla](https://www.apple.com/legal/sla/)) first.
