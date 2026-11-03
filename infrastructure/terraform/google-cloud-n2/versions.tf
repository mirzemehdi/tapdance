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

# Only for the budget (budget_amount_usd): the Billing Budgets API refuses user credentials unless
# requests name a quota project (billing_project + user_project_override, per the provider's docs).
provider "google" {
  alias                 = "billing"
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}
