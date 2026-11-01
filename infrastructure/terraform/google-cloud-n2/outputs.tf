locals {
  gcloud_target = "${google_compute_instance.worker.name} --zone ${var.zone} --project ${local.project_id}"
  ssh_command   = var.enable_iap_ssh ? "gcloud compute ssh ${local.gcloud_target} --tunnel-through-iap" : "SSH is closed (enable_iap_ssh = false). Set it to true and apply to open IAP SSH again."
}

output "project_id" {
  description = "Project the worker lives in."
  value       = local.project_id
}

output "instance_name" {
  description = "Name of the worker VM."
  value       = google_compute_instance.worker.name
}

output "zone" {
  description = "Zone of the worker VM."
  value       = var.zone
}

output "internal_ip" {
  description = "Private IP of the VM. Nothing listens on it for other machines: the worker dials out to the gateway."
  value       = google_compute_instance.worker.network_interface[0].network_ip
}

output "service_account_email" {
  description = "The VM's dedicated service account (logging and monitoring only)."
  value       = google_service_account.worker.email
}

output "iap_ssh_command" {
  description = "Open a shell on the VM through Identity-Aware Proxy (no public SSH port)."
  value       = local.ssh_command
}

output "next_steps" {
  description = "What to run after terraform apply."
  value       = <<-EOT
    1. Wait 1-2 minutes for the startup script, then open a shell:
         ${local.ssh_command}
    2. Check KVM (read-only):
         bash /opt/tapdance/check-kvm.sh
    3. Install the worker. Read the Android SDK licences first; the flag accepts them for you:
         bash /opt/tapdance/install-android-worker.sh --accept-android-licenses --gateway wss://<gateway-host> --label ${google_compute_instance.worker.name}
    4. On the gateway machine, mint a join token (shown once):
         tapdance gateway token --role worker --label ${google_compute_instance.worker.name}
    5. Back on the VM, join. The token is read from a hidden prompt, never from the command line:
         tapdance worker login --accept-gateway-exec --gateway wss://<gateway-host> --label ${google_compute_instance.worker.name}
    6. On the gateway: tapdance workers list && tapdance devices
    The gateway must use TLS (wss://) or a private network such as Tailscale.
  EOT
}

output "stop_command" {
  description = "Stop the VM. vCPU and RAM billing stop; the boot disk keeps billing. Check the Cloud NAT pricing page for what a NAT gateway costs while no VM runs."
  value       = "gcloud compute instances stop ${local.gcloud_target}"
}

output "start_command" {
  description = "Start the VM again. The worker service starts on boot (lingering) and reconnects to the gateway by itself."
  value       = "gcloud compute instances start ${local.gcloud_target}"
}

output "delete_command" {
  description = "Delete everything this configuration created. Revoke the worker's join token on the gateway too."
  value       = "terraform destroy   # then on the gateway: tapdance simlock --gateway token list ; tapdance simlock --gateway token revoke <id>"
}

output "cost_note" {
  description = "Rough cost, as estimated in November 2026. Check the pricing pages before relying on it."
  value       = <<-EOT
    Estimate (November 2026, us-central1, on-demand, before taxes; prices change, verify at
    https://cloud.google.com/compute/vm-instance-pricing and https://cloud.google.com/products/calculator):
      Machine type ${var.machine_type}. An n2-standard-4 costs about USD 0.194/hour (about USD 142 for a 730-hour month,
        about USD 113 with the full-month sustained use discount). Billed only while running.
      Boot disk ${var.boot_disk_size_gb} GB ${var.boot_disk_type}: pd-balanced is about USD 0.10/GB-month
        (about USD ${format("%.2f", var.boot_disk_size_gb * 0.10)}/month). Billed while the VM is stopped too.
      ${var.assign_external_ip ? "Ephemeral external IP: about USD 0.005/hour while the VM runs." : "Cloud NAT: about USD 0.0014/hour per VM using it, plus USD 0.005/hour for its external IP, plus USD 0.045 per GiB processed (the SDK and image downloads are a few GiB once; live screen streaming adds more). See https://cloud.google.com/nat/pricing."}
      Data sent from the VM to the internet (your gateway) is billed as egress.
    Stop the VM when no agent needs it; delete it with terraform destroy when you are done.
  EOT
}
