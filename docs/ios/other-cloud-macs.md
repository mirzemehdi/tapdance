# Other cloud Macs: MacStadium and AWS EC2 Mac

> **Not run.** Nobody has set up Tapdance on a MacStadium Mac or an AWS EC2 Mac yet. The provider facts
> below come from the providers' public pages (read in November 2026). The Tapdance steps are the ones
> proven on a rented [Scaleway Mac mini](scaleway-mac.md)
> ([evidence](../testing/evidence/2026-11-06-rented-mac-ios.md)). If you try one, please file what
> happened with `tapdance report`.

## What you get

A Mac you rent from MacStadium or AWS, set up as an iOS **host** in
[device-only mode](../security/device-only-mode.md). Your agent, on another machine, leases iOS
simulators on it through the **guard**. Tapdance has no integration with either provider and no cloud
SDK: you rent and reach the Mac yourself, then follow the Scaleway steps.

## What you need

- An account with the provider, and a way to ssh into the Mac.
- At least 16 GB of memory is safer. On an 8 GB Mac, run one simulator at a time
  ([why](scaleway-mac.md#8-gb-one-simulator-at-a-time)).
- A Tailscale account, and Tapdance installed on the agent's machine
  ([installation](../installation.md)).

## Steps

1. Rent the Mac and ssh into it: see [MacStadium](#macstadium) or [AWS EC2 Mac](#aws-ec2-mac) below.
2. Follow [the Scaleway guide from step 2](scaleway-mac.md#2-xcode-and-an-ios-runtime): Xcode first
   launch and an iOS runtime, automatic login, `host-setup.sh --ios-only` (which runs `tapdance host up`),
   then `tapdance connect` on the agent's machine.
3. When you are done, stop paying: [MacStadium](#stop-paying-macstadium),
   [AWS](#stop-paying-aws).

## Check it worked

As on Scaleway: [check it worked](scaleway-mac.md#check-it-worked).

## If it fails

The Scaleway guide's [If it fails](scaleway-mac.md#if-it-fails), and
[troubleshooting](../troubleshooting.md). Differences between providers (user name, Homebrew or
MacPorts, macOS version) are the likeliest cause: note them in your report.

## MacStadium

[MacStadium](https://www.macstadium.com/) rents dedicated bare-metal Macs (Mac mini, Mac Studio) on
monthly or annual terms, and sells Orka, its macOS virtualization product.

**When to choose it:** you want a Mac that stays yours month after month with no hourly billing, a
larger disk (several iOS runtimes), or you already use MacStadium for CI. For a short experiment, an
hourly Mac (Scaleway, AWS) is usually cheaper, though both have a 24-hour minimum.

**Pricing** (from the [pricing page](https://www.macstadium.com/pricing), November 2026 estimates; check
your quote):

| Plan | Hardware | Price |
| --- | --- | --- |
| M2.S | M2, 8 GB RAM, 256 GB SSD | about $109 per month |
| M2.M | M2, 16 GB RAM, 1 TB SSD | about $199 per month |
| M4 tiers | M4 / M4 Pro | higher; prices were raised in mid-2026 |

The page offers monthly or annual pricing. We could not confirm a minimum contract term from public
pages; ask MacStadium before you order.

**Bare metal or Orka?** Start with a bare-metal Mac: one Mac, one host. With Orka, each macOS VM would be
its own host; simulator performance inside a VM and Apple's virtualization terms need checking first.
Neither has been tried with Tapdance.

**Access.** MacStadium hands over an IP address and credentials. Connect over ssh with a key. Use VNC or
Screen Sharing only through an ssh tunnel or MacStadium's VPN, never on a public port:

```bash
ssh -L 5900:127.0.0.1:5900 <user>@<mac-ip>
```

Then open `vnc://127.0.0.1:5900` on your own Mac. This assumes Screen Sharing is on; MacStadium's
onboarding docs describe the remote access they provide.

**macOS and Xcode.** Check `xcodebuild -version`. Install or update Xcode if needed, then:

```bash
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
```

Turn off system sleep if it is on (`sudo pmset -a sleep 0`).

### Stop paying (MacStadium)

On the agent's machine, `tapdance device release`. On the Mac, `tapdance host down --all`. Then cancel
the plan with MacStadium according to your contract.

## AWS EC2 Mac

AWS runs macOS on real Apple hardware as EC2 Mac instances. Each one needs an EC2 **Dedicated Host**: a
whole Mac allocated to your account.

**Pricing and minimums** (from the [EC2 Mac page](https://aws.amazon.com/ec2/instance-types/mac/),
November 2026 estimates):

- **24 hours minimum** per Dedicated Host, to comply with Apple's macOS license. After that you can
  release the host at any time.
- Billing is per second after the minimum. You pay for the **host** while it is allocated, whether or
  not an instance runs on it.
- On-Demand Dedicated Hosts, or Savings Plans (AWS quotes up to 44% off with a 3-year commitment).
- Example: `mac2-m2.metal` around **$0.88 per hour** On-Demand (a
  [third-party listing](https://instances.vantage.sh/aws/ec2/mac2-m2.metal), region not stated), so the
  24-hour minimum is roughly $21. Confirm on
  [Dedicated Hosts pricing](https://aws.amazon.com/ec2/dedicated-hosts/pricing/) or the AWS Pricing
  Calculator for your region.

**Instance types** (as read on 2026-11-01):

| Type | Chip | Memory | Notes |
| --- | --- | --- | --- |
| `mac2.metal` | M1 | 16 GB | Closest to the Mac Tapdance was first tested on (M1 Pro, 16 GB) |
| `mac2-m2.metal` | M2 | 24 GB | A sensible first choice for a few simulators |
| `mac2-m2pro.metal` | M2 Pro | 32 GB | More simulators at once |
| `mac2-m1ultra.metal` | M1 Ultra | 128 GB | Large |
| `mac-m4.metal`, `mac-m4pro.metal`, `mac-m4max.metal`, `mac-m3ultra.metal` | M4 / M4 Pro / M4 Max / M3 Ultra | 24–256 GB | Newer; the M4 types need macOS 15.6 or later per AWS |
| `mac1.metal` | Intel | 32 GB | Intel; not tested with Simlock |

**Credentials.** Use AWS IAM Identity Center (`aws configure sso`) or another short-lived method for the
AWS CLI. Never put AWS keys in a repository, a config file, a shell history or a chat with an agent.
Do not give your agent AWS credentials: Tapdance never needs them, because the agent only talks to the
guard on the Mac. Do not store AWS keys on the Mac either. If the instance needs AWS access, attach an IAM
role with the smallest permissions; an agent that gets code onto the Mac (an installed iOS app runs as
the hosting account) could reach whatever that role can.

**Allocate a host and launch macOS.** In the EC2 console (Dedicated Hosts > Allocate), or:

```bash
aws ec2 allocate-hosts --instance-type mac2-m2.metal --availability-zone us-east-1a --quantity 1
```

Note the returned `HostId`; the 24-hour minimum starts now. Not every zone has every Mac type. Then
launch a current macOS AMI on that host:

```bash
aws ec2 run-instances --image-id <macos-ami-id> --instance-type mac2-m2.metal --placement "HostId=<host-id>" --key-name <your-key-pair> --security-group-ids <sg-id> --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3}'
```

Check your AMI's root device name before you copy the mapping. AWS's macOS AMIs include the Command Line
Tools for Xcode, Homebrew, the AWS CLI and the SSM Agent, but **not** the full Xcode app
([AMI notes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/macos-ami-overview.html)). AWS notes the
100 GB default volume is not enough for Xcode; 200 GB or more is a reasonable start.

**Network.** Tapdance needs **no inbound rule**: the agent reaches the guard over Tailscale. Allow ssh
only from your own IP, or use SSM Session Manager and allow no inbound traffic at all.

**Access.**

```bash
ssh -i <key.pem> ec2-user@<public-dns>
```

For the desktop (some Xcode installs need it), AWS documents turning on Screen Sharing and connecting
through an ssh tunnel ([AWS guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-to-mac-instance.html)).
On the instance:

```bash
sudo passwd ec2-user
sudo launchctl enable system/com.apple.screensharing
sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist
```

Then, from your own computer:

```bash
ssh -i <key.pem> -L 5900:localhost:5900 ec2-user@<public-dns>
```

Open `vnc://localhost:5900` on your own Mac. Never open port 5900 in the security group. On macOS Sequoia
and later, AWS asks you to approve the Local Network Privacy prompt once in the GUI (see the AMI notes).

**Xcode.** Install it from the App Store over Screen Sharing, or download the `.xip` from
[developer.apple.com/download](https://developer.apple.com/download/) (Apple ID required). Then run the
same `xcode-select`, `-license accept` and `-runFirstLaunch` commands as for MacStadium above. Do not
store your Apple ID password on the instance; sign out of the App Store when Xcode is installed.

### Stop paying (AWS)

1. On the agent's machine, `tapdance device release`. On the Mac, `tapdance host down --all`.
2. Terminate the instance. Stopping it is not enough: the host keeps billing.
3. Release the host after the 24-hour minimum:

   ```bash
   aws ec2 release-hosts --host-ids <host-id>
   ```

After an instance terminates, AWS scrubs the Mac before the host can be released, which can take a
while. Check the host's state in the console and release it when AWS allows.

## Provisioning integrations

Tapdance has no code that rents or sets up cloud Macs; manual setup comes first, on purpose. If one is
built, it must take credentials from the provider's standard chain (for AWS: SSO, instance roles), never
from Tapdance config or MCP, and must respect the 24-hour minimum when it releases a host.

## Apple licensing note

The 24-hour minimum comes from Apple's macOS Software License Agreement. Renting a whole Mac for your
own testing is what these providers sell. Sharing Macs with other people, renting them onward, running
several macOS VMs on one Mac, or offering short sessions needs a review of the current license
([apple.com/legal/sla](https://www.apple.com/legal/sla/)) first.
