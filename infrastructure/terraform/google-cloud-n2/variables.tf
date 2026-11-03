# ------------------------------------------------------------------ project

variable "project_id" {
  description = "Google Cloud project ID. By default it must already exist (create_project = false)."
  type        = string
}

variable "create_project" {
  description = "Create the project instead of using an existing one. Off by default. Needs billing_account and one of org_id / folder_id."
  type        = bool
  default     = false
}

variable "project_name" {
  description = "Display name when create_project is true."
  type        = string
  default     = "Tapdance Android worker"
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX). Used when create_project is true, and by budget_amount_usd."
  type        = string
  default     = null
}

variable "org_id" {
  description = "Organization ID for a new project (create_project = true). Leave null to use folder_id."
  type        = string
  default     = null
}

variable "folder_id" {
  description = "Folder ID for a new project (create_project = true). Leave null to use org_id."
  type        = string
  default     = null
}

variable "project_deletion_policy" {
  description = "deletion_policy of a project this module creates: PREVENT (default; terraform destroy refuses to delete the project), ABANDON or DELETE."
  type        = string
  default     = "PREVENT"

  validation {
    condition     = contains(["PREVENT", "ABANDON", "DELETE"], var.project_deletion_policy)
    error_message = "project_deletion_policy must be PREVENT, ABANDON or DELETE."
  }
}

# ------------------------------------------------------------------ location

variable "region" {
  description = "Region for the subnet, Cloud Router and Cloud NAT. Pick one where N2 is offered."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the VM. Must be in var.region and offer N2 machine types."
  type        = string
  default     = "us-central1-a"
}

# ------------------------------------------------------------------ machine

variable "name" {
  description = "Name prefix for every resource (VM, network, service account)."
  type        = string
  default     = "tapdance-n2"

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,18}[a-z0-9])?$", var.name))
    error_message = "name must be 1-20 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "machine_type" {
  description = "N2 machine type. Nested virtualization (KVM inside the VM) is required for the Android Emulator; N2D, E2 and Arm machine types do not support it and are refused."
  type        = string
  default     = "n2-standard-4"

  validation {
    condition     = can(regex("^n2-", var.machine_type))
    error_message = "machine_type must be an N2 type (n2-standard-4, n2-standard-8, n2-highmem-4, n2-custom-...). N2D, E2 and other series are refused: they cannot run the Android Emulator with KVM here."
  }
}

variable "min_cpu_platform" {
  description = "Minimum Intel CPU platform. Cascade Lake or newer."
  type        = string
  default     = "Intel Cascade Lake"

  validation {
    condition     = contains(["Intel Cascade Lake", "Intel Ice Lake"], var.min_cpu_platform)
    error_message = "min_cpu_platform must be \"Intel Cascade Lake\" or \"Intel Ice Lake\"."
  }
}

variable "boot_image" {
  description = "Boot image or image family. The install script supports Ubuntu 22.04 and 24.04 LTS on x86_64."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "boot_disk_size_gb" {
  description = "Boot disk size in GB. The Android SDK, one system image and Simlock's emulator copies need roughly 25-40 GB."
  type        = number
  default     = 64

  validation {
    condition     = var.boot_disk_size_gb >= 50 && var.boot_disk_size_gb <= 100
    error_message = "boot_disk_size_gb must be between 50 and 100."
  }
}

variable "boot_disk_type" {
  description = "Boot disk type."
  type        = string
  default     = "pd-balanced"

  validation {
    condition     = contains(["pd-balanced", "pd-ssd"], var.boot_disk_type)
    error_message = "boot_disk_type must be pd-balanced or pd-ssd."
  }
}

variable "on_host_maintenance" {
  description = "What Google does to the VM during host maintenance: MIGRATE (live-migrate, Google's default) or TERMINATE (stop; restart if automatic_restart). Behaviour of a running nested emulator during live migration has not been tested."
  type        = string
  default     = "MIGRATE"

  validation {
    condition     = contains(["MIGRATE", "TERMINATE"], var.on_host_maintenance)
    error_message = "on_host_maintenance must be MIGRATE or TERMINATE."
  }
}

variable "deletion_protection" {
  description = "Refuse to delete the VM until this is set back to false."
  type        = bool
  default     = false
}

variable "labels" {
  description = "Extra labels for the VM and disk."
  type        = map(string)
  default     = {}
}

# ------------------------------------------------------------------ network and access

variable "subnet_cidr" {
  description = "IPv4 range of the dedicated subnet."
  type        = string
  default     = "10.42.0.0/24"
}

variable "enable_iap_ssh" {
  description = "Allow SSH (TCP 22) only from Google's IAP TCP-forwarding range 35.235.240.0/20, and enable the IAP API. Set false after the worker has joined to close SSH completely."
  type        = bool
  default     = true
}

variable "assign_external_ip" {
  description = "Give the VM an ephemeral external IP for outbound traffic instead of using Cloud NAT. No inbound port is opened either way: the firewall still allows only IAP SSH."
  type        = bool
  default     = false
}

variable "ssh_members" {
  description = "IAM principals (e.g. \"user:you@example.com\") allowed to SSH through IAP with sudo: granted IAP tunnel access to this VM, roles/compute.osAdminLogin on it, and roles/iam.serviceAccountUser on its service account. Leave empty to manage access yourself."
  type        = list(string)
  default     = []
}

variable "grant_logging_roles" {
  description = "Grant the VM's service account roles/logging.logWriter and roles/monitoring.metricWriter so the guest agent can write logs and metrics. Nothing else is granted."
  type        = bool
  default     = true
}

# ------------------------------------------------------------------ cost guards
#
# Three layers, from hardest to softest. On the VM itself, the Tapdance guard can also power it off
# when idle (`tapdance host up --idle-stop`); these work even when the guard does not run.

variable "max_run_hours" {
  description = "Per-boot hard cap: Compute Engine STOPS (never deletes) the VM this many hours after each start. The countdown starts when the VM is RUNNING, restarts at every start and is cleared by a stop; a reboot inside the VM does not reset it. The boot disk is kept (and still billed). 0 or null turns it off. Google allows 30 seconds to 120 days; here 1 to 2880 whole hours. Sets scheduling.max_run_duration with instance_termination_action = \"STOP\" (standard provisioning; GA in hashicorp/google 6.x). A running lease is cut off when the cap hits."
  type        = number
  default     = 8

  validation {
    condition     = var.max_run_hours == null ? true : (var.max_run_hours == 0 || (var.max_run_hours >= 1 && var.max_run_hours <= 2880 && floor(var.max_run_hours) == var.max_run_hours))
    error_message = "max_run_hours must be 0 or null (off), or a whole number of hours from 1 to 2880 (120 days)."
  }
}

variable "stop_schedule" {
  description = "Unix-cron schedule at which Compute Engine stops the VM, in schedule_time_zone, e.g. \"0 20 * * *\" for 20:00 every day. null: no schedule. Creates an instance schedule (google_compute_resource_policy) in var.region (a schedule only applies to VMs in its own region) and grants the Compute Engine Service Agent (service-PROJECT_NUMBER@compute-system.iam.gserviceaccount.com) roles/compute.instanceAdmin.v1 on the project, which Google requires for schedules to stop VMs. A scheduled stop can begin up to 15 minutes late. It only stops; start the VM yourself. Changing this later recreates the VM (resource_policies cannot change in place), which wipes the boot disk."
  type        = string
  default     = null
}

variable "schedule_time_zone" {
  description = "IANA time zone for stop_schedule, e.g. \"Europe/Berlin\" or \"America/New_York\"."
  type        = string
  default     = "UTC"
}

variable "budget_amount_usd" {
  description = "Monthly budget in USD for this project, with alert e-mails to the billing account's admins at 50%, 90% and 100% of actual spend. ALERTS ONLY: a Google Cloud budget never stops, caps or slows the VM; max_run_hours and the guard's idle stop do that. null: no budget. Needs billing_account (billed in USD), the Cloud Billing Budget API (enabled here) and billing.budgets.create on the billing account (Billing Account Administrator or Billing Account Costs Manager). The budget is created through a provider alias with user_project_override, as the hashicorp/google docs require for user credentials."
  type        = number
  default     = null

  validation {
    condition     = var.budget_amount_usd == null ? true : var.budget_amount_usd >= 1
    error_message = "budget_amount_usd must be at least 1, or null for no budget."
  }
}
