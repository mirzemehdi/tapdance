# Tapdance Android worker on a Google Cloud N2 VM with nested virtualization.
#
# Creates: (optionally) a project; the Compute/IAM/OS Login (and IAP) APIs; a dedicated VPC and
# subnet; firewall rules that allow only IAP SSH; Cloud NAT for outbound traffic (or an ephemeral
# external IP); a service account with logging/monitoring only; and one N2 VM running Ubuntu
# 24.04 with a startup script that prepares KVM and copies the Tapdance install scripts.
#
# It does NOT install Tapdance or join a gateway: the gateway join token must never be in
# Terraform state or instance metadata. You run the install script and `tapdance worker login`
# yourself over IAP SSH. See README.md.
#
# Not yet validated with `terraform validate` or applied anywhere. See STATUS.md (G-01, G-02).

locals {
  project_id = var.create_project ? google_project.this[0].project_id : var.project_id

  base_services = [
    "compute.googleapis.com",
    "iam.googleapis.com",
    "oslogin.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ]
  services = concat(local.base_services, var.enable_iap_ssh ? ["iap.googleapis.com"] : [])

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

# SSH only from IAP's TCP-forwarding range, only to this worker. No device, ADB, emulator or
# Simlock port is ever opened: the worker dials out to the gateway.
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

# Outbound internet (apt, Google's SDK downloads, git, the gateway's wss:// address) without an
# external IP.
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
  }

  # No secrets here: instance metadata is readable by anything on the VM and by anyone with
  # compute.instances.get on the project. The join token is typed over IAP SSH instead.
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = local.startup_script
  }

  depends_on = [
    google_project_service.services,
    google_compute_router_nat.this,
  ]
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
