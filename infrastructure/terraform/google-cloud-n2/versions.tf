# Not yet validated: Terraform was not available where this was written. Run
# `terraform init && terraform validate` before the first `terraform plan`. See README.md.
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0, < 8.0"
    }
  }
}

provider "google" {
  # When create_project is true the project does not exist yet; resources pass `project`
  # explicitly, so this default only matters for provider-level API calls.
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
