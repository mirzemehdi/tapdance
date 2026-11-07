# Tapdance Android host on a Google Cloud N2 VM with nested virtualization.
#
# Creates: (optionally) a project; the Compute/IAM/OS Login (and IAP) APIs; a dedicated VPC and
# subnet; firewall rules that allow only IAP SSH; Cloud NAT for outbound traffic (or an ephemeral
# external IP); a service account with logging/monitoring only; and one N2 VM running Ubuntu
# 24.04 with a startup script that prepares KVM and copies helper scripts.
# Cost guards: a per-boot run-time cap that stops the VM (max_run_hours, on by default: 8 h; with
# on_run_limit = "DELETE" it deletes the VM and its disk instead, for test hosts), and
# optionally a scheduled stop (stop_schedule) and a budget with alert e-mails (budget_amount_usd).
#
# It does NOT install Tapdance, Tailscale or a pairing token: no secret may be in Terraform state or
# instance metadata. You run scripts/host-setup.sh (which runs `tapdance host up`) yourself over IAP
# SSH. See README.md.
#
# Passes `terraform validate` (1.17.1). Applied in the field runs since 2026-11-03 (with
# assign_external_ip = true; ephemeral mode, on_run_limit = "DELETE", too) and removed again with
# `terraform destroy`. Not run: the Cloud NAT default, create_project, stop_schedule. See STATUS.md
# (G-01, G-02, G-07, G-08).

locals {
  project_id = var.create_project ? google_project.this[0].project_id : var.project_id

  base_services = [
    "compute.googleapis.com",
    "iam.googleapis.com",
    "oslogin.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
  services = concat(
    local.base_services,
    var.enable_iap_ssh ? ["iap.googleapis.com"] : [],
    var.budget_amount_usd != null ? ["billingbudgets.googleapis.com"] : [],
  )

  # Cost guards (variables.tf). 0 or null: off.
  max_run_seconds = coalesce(var.max_run_hours, 0) * 3600
  needs_number    = var.stop_schedule != null || var.budget_amount_usd != null
  project_number  = local.needs_number ? data.google_project.this[0].number : null

  # Google's documented source range for IAP TCP forwarding.
  iap_source_range = "35.235.240.0/20"
  network_tag      = "${var.name}-worker"

  labels = merge({ app = "tapdance", role = "android-worker" }, var.labels)

  startup_script = templatefile("${path.module}/startup-script.sh.tftpl", {
    install_worker_b64 = base64encode(file("${path.module}/../../scripts/install-android-worker.sh"))
    check_kvm_b64      = base64encode(file("${path.module}/../../scripts/check-kvm.sh"))
  })
}

# ------------------------------------------------------------------ project (optional)

resource "google_project" "this" {
  count = var.create_project ? 1 : 0

  project_id      = var.project_id
  name            = var.project_name
  billing_account = var.billing_account
  org_id          = var.folder_id == null ? var.org_id : null
  folder_id       = var.folder_id
  deletion_policy = var.project_deletion_policy
  labels          = { app = "tapdance" }

  lifecycle {
    precondition {
      condition     = var.billing_account != null && (var.org_id != null || var.folder_id != null)
      error_message = "create_project = true needs billing_account and org_id or folder_id."
    }
  }
}

resource "google_project_service" "services" {
  for_each = toset(local.services)

  project            = local.project_id
  service            = each.value
  disable_on_destroy = false
}

# ------------------------------------------------------------------ network

resource "google_compute_network" "this" {
  project                 = local.project_id
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.services]
}

resource "google_compute_subnetwork" "this" {
  project                  = local.project_id
  name                     = "${var.name}-subnet"
  region                   = var.region
  network                  = google_compute_network.this.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# SSH only from IAP's TCP-forwarding range, only to this worker. No device, ADB, emulator, Simlock
# or guard port is ever opened: the agent's machine reaches the worker guard over Tailscale
# (`tailscale serve`, set up by `tapdance host up`), whose connections the VM opens outbound.
resource "google_compute_firewall" "allow_iap_ssh" {
  count = var.enable_iap_ssh ? 1 : 0

  project       = local.project_id
  name          = "${var.name}-allow-iap-ssh"
  network       = google_compute_network.this.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = [local.iap_source_range]
  target_tags   = [local.network_tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Explicit deny of all other ingress. The VPC's implied rule already denies it; this rule makes
# the intent visible in the console. Rules with a lower priority number (such as the IAP rule
# above, priority 1000) still win, so anything you add later must be reviewed with that in mind.
resource "google_compute_firewall" "deny_all_ingress" {
  project       = local.project_id
  name          = "${var.name}-deny-all-ingress"
  network       = google_compute_network.this.id
  direction     = "INGRESS"
  priority      = 65000
  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }
}

# Outbound internet (apt, Google's SDK downloads, git, Tailscale's coordination and relay servers)
# without an external IP.
resource "google_compute_router" "this" {
  count = var.assign_external_ip ? 0 : 1

  project = local.project_id
  name    = "${var.name}-router"
  region  = var.region
  network = google_compute_network.this.id
}

resource "google_compute_router_nat" "this" {
  count = var.assign_external_ip ? 0 : 1

  project                            = local.project_id
  name                               = "${var.name}-nat"
  router                             = google_compute_router.this[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = google_compute_subnetwork.this.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# ------------------------------------------------------------------ service account

resource "google_service_account" "worker" {
  project      = local.project_id
  account_id   = "${var.name}-worker"
  display_name = "Tapdance Android worker (${var.name})"
  description  = "Runs the Tapdance N2 worker VM. Logging and monitoring only; no other access."

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "worker_logging" {
  for_each = var.grant_logging_roles ? toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"]) : toset([])

  project = local.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# ------------------------------------------------------------------ the VM

resource "google_compute_instance" "worker" {
  project                   = local.project_id
  name                      = var.name
  zone                      = var.zone
  machine_type              = var.machine_type
  min_cpu_platform          = var.min_cpu_platform
  tags                      = [local.network_tag]
  labels                    = local.labels
  deletion_protection       = var.deletion_protection
  allow_stopping_for_update = true

  # KVM inside the VM, so the Android Emulator runs with hardware acceleration.
  advanced_machine_features {
    enable_nested_virtualization = true
  }

  boot_disk {
    auto_delete = true

    initialize_params {
      image  = var.boot_image
      size   = var.boot_disk_size_gb
      type   = var.boot_disk_type
      labels = local.labels
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.this.id

    dynamic "access_config" {
      for_each = var.assign_external_ip ? [1] : []
      content {
        # Ephemeral external IP, used for outbound traffic only.
      }
    }
  }

  service_account {
    email  = google_service_account.worker.email
    scopes = ["https://www.googleapis.com/auth/logging.write", "https://www.googleapis.com/auth/monitoring.write"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    on_host_maintenance = var.on_host_maintenance
    automatic_restart   = true
    preemptible         = false

    # Per-boot hard cap (max_run_hours): Compute Engine stops the VM, or with on_run_limit = "DELETE"
    # deletes it together with its boot disk (auto_delete above), so nothing of it bills afterwards.
    instance_termination_action = local.max_run_seconds > 0 ? var.on_run_limit : null

    dynamic "max_run_duration" {
      for_each = local.max_run_seconds > 0 ? [local.max_run_seconds] : []
      content {
        seconds = max_run_duration.value
      }
    }
  }

  # A scheduled stop (stop_schedule). Changing this list recreates the VM.
  resource_policies = var.stop_schedule != null ? [google_compute_resource_policy.stop_schedule[0].self_link] : null

  # No secrets here: instance metadata is readable by anything on the VM and by anyone with
  # compute.instances.get on the project. `tapdance host up` writes the pairing token to a file on
  # the VM, and you copy it over IAP SSH instead.
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = local.startup_script
  }

  lifecycle {
    precondition {
      condition     = var.on_run_limit != "DELETE" || local.max_run_seconds > 0
      error_message = "on_run_limit = \"DELETE\" needs max_run_hours of 1 or more: without a run-time limit nothing ever deletes the VM."
    }
    precondition {
      condition     = var.on_run_limit != "DELETE" || !var.deletion_protection
      error_message = "on_run_limit = \"DELETE\" cannot delete a VM with deletion_protection = true. Turn one of them off."
    }
  }

  depends_on = [
    google_project_service.services,
    google_compute_router_nat.this,
    google_project_iam_member.schedule_agent,
  ]
}

# ------------------------------------------------------------------ cost guards (optional)

data "google_project" "this" {
  count = local.needs_number ? 1 : 0

  project_id = local.project_id
}

# Stops the VM on a cron schedule. Only stops; starting stays a deliberate act.
resource "google_compute_resource_policy" "stop_schedule" {
  count = var.stop_schedule != null ? 1 : 0

  project     = local.project_id
  name        = "${var.name}-stop-schedule"
  region      = var.region
  description = "Stops the Tapdance host VM on a schedule so it does not run (and bill) overnight."

  instance_schedule_policy {
    vm_stop_schedule {
      schedule = var.stop_schedule
    }
    time_zone = var.schedule_time_zone
  }

  depends_on = [google_project_service.services]
}

# Instance schedules act as the Compute Engine Service Agent, which needs compute.instances.stop:
# Google's documented grant is roles/compute.instanceAdmin.v1 on the project.
resource "google_project_iam_member" "schedule_agent" {
  count = var.stop_schedule != null ? 1 : 0

  project = local.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:service-${local.project_number}@compute-system.iam.gserviceaccount.com"
}

# Alerts only: a budget never stops or caps anything.
resource "google_billing_budget" "this" {
  count    = var.budget_amount_usd != null ? 1 : 0
  provider = google.billing

  billing_account = var.billing_account
  display_name    = "${var.name} monthly budget"

  budget_filter {
    projects = ["projects/${local.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(floor(var.budget_amount_usd))
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  lifecycle {
    precondition {
      condition     = var.billing_account != null
      error_message = "budget_amount_usd needs billing_account (XXXXXX-XXXXXX-XXXXXX)."
    }
  }

  depends_on = [google_project_service.services]
}

# ------------------------------------------------------------------ who may SSH in (optional)

resource "google_iap_tunnel_instance_iam_member" "ssh" {
  for_each = var.enable_iap_ssh ? toset(var.ssh_members) : toset([])

  project  = local.project_id
  zone     = var.zone
  instance = google_compute_instance.worker.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}

resource "google_compute_instance_iam_member" "os_admin_login" {
  for_each = toset(var.ssh_members)

  project       = local.project_id
  zone          = var.zone
  instance_name = google_compute_instance.worker.name
  role          = "roles/compute.osAdminLogin"
  member        = each.value
}

# OS Login on a VM with an attached service account also requires actAs on that account.
resource "google_service_account_iam_member" "ssh_act_as" {
  for_each = toset(var.ssh_members)

  service_account_id = google_service_account.worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}
