###############################################################################
# DLMS Polyglot – AWS Infrastructure
# Provisions: VPC · RDS PostgreSQL · OpenSearch · S3 · ECS Fargate · ALB
###############################################################################

terraform {
  required_version = ">= 1.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }

  # Uncomment to use S3 remote state
  # backend "s3" {
  #   bucket = "my-terraform-state"
  #   key    = "dlms/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "dlms-polyglot"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

###############################################################################
# Variables
###############################################################################

variable "aws_region"      { default = "us-east-1" }
variable "environment"     { default = "prod" }
variable "app_name"        { default = "dlms" }
variable "vpc_cidr"        { default = "10.0.0.0/16" }
variable "pg_instance"     { default = "db.t3.medium" }
variable "pg_db_name"      { default = "dlms" }
variable "pg_username"     { sensitive = true }
variable "pg_password"     { sensitive = true }
variable "os_instance"     { default = "t3.medium.search" }
variable "os_volume_gb"    { default = 50 }
variable "ecs_cpu"         { default = 512 }
variable "ecs_memory"      { default = 1024 }
variable "container_image" { description = "ECR image URI for the DLMS server" }
variable "certificate_arn" { default = "" description = "ACM cert ARN for HTTPS (optional)" }

locals {
  name_prefix = "${var.app_name}-${var.environment}"
}

###############################################################################
# VPC & Networking
###############################################################################

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "${local.name_prefix}-vpc" }
}

data "aws_availability_zones" "available" { state = "available" }

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name_prefix}-private-${count.index + 1}" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name_prefix}-public-${count.index + 1}" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_eip" "nat" {
  count  = 1
  domain = "vpc"
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name_prefix}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

###############################################################################
# Security Groups
###############################################################################

resource "aws_security_group" "alb" {
  name   = "${local.name_prefix}-alb-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 80;  to_port = 80;  protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443; to_port = 443; protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name   = "${local.name_prefix}-app-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name   = "${local.name_prefix}-rds-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_security_group" "opensearch" {
  name   = "${local.name_prefix}-os-sg"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

###############################################################################
# RDS PostgreSQL (System of Record)
###############################################################################

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet-group"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_kms_key" "rds" {
  description             = "RDS encryption key for ${local.name_prefix}"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_db_instance" "postgres" {
  identifier              = "${local.name_prefix}-postgres"
  engine                  = "postgres"
  engine_version          = "16.2"
  instance_class          = var.pg_instance
  allocated_storage       = 20
  max_allocated_storage   = 500
  storage_encrypted       = true
  kms_key_id              = aws_kms_key.rds.arn
  db_name                 = var.pg_db_name
  username                = var.pg_username
  password                = var.pg_password
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  multi_az                = var.environment == "prod"
  backup_retention_period = 30
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:00-sun:05:00"
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name_prefix}-final-snapshot" : null
  performance_insights_enabled = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot = true
  tags = { Name = "${local.name_prefix}-postgres" }
}

###############################################################################
# OpenSearch (Search Layer)
###############################################################################

resource "aws_opensearch_domain" "main" {
  domain_name    = "${local.name_prefix}-search"
  engine_version = "OpenSearch_2.13"

  cluster_config {
    instance_type  = var.os_instance
    instance_count = var.environment == "prod" ? 2 : 1
    zone_awareness_enabled = var.environment == "prod"

    dynamic "zone_awareness_config" {
      for_each = var.environment == "prod" ? [1] : []
      content { availability_zone_count = 2 }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.os_volume_gb
    throughput  = 125
  }

  encrypt_at_rest {
    enabled    = true
    kms_key_id = aws_kms_key.rds.arn
  }

  node_to_node_encryption { enabled = true }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  vpc_options {
    subnet_ids         = [aws_subnet.private[0].id]
    security_group_ids = [aws_security_group.opensearch.id]
  }

  advanced_security_options {
    enabled                        = true
    anonymous_auth_enabled         = false
    internal_user_database_enabled = true
    master_user_options {
      master_user_name     = "dlms-admin"
      master_user_password = random_password.os_master.result
    }
  }

  log_publishing_options {
    log_type                 = "INDEX_SLOW_LOGS"
    cloudwatch_log_group_arn = aws_cloudwatch_log_group.os_logs.arn
  }

  tags = { Name = "${local.name_prefix}-opensearch" }
}

resource "random_password" "os_master" {
  length  = 32
  special = true
}

resource "aws_cloudwatch_log_group" "os_logs" {
  name              = "/aws/opensearch/${local.name_prefix}"
  retention_in_days = 30
}

###############################################################################
# S3 Buckets (attachments + backups)
###############################################################################

resource "aws_kms_key" "s3" {
  description         = "S3 encryption for ${local.name_prefix}"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "attachments" {
  bucket = "${local.name_prefix}-attachments-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "DLMS Attachments" }
}

resource "aws_s3_bucket" "backups" {
  bucket = "${local.name_prefix}-backups-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "DLMS Backups" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

###############################################################################
# ECS Fargate (Application)
###############################################################################

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  managed_policy_arns = ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })

  inline_policy {
    name = "dlms-task-policy"
    policy = jsonencode({
      Version = "2012-10-17"
      Statement = [
        {
          Effect   = "Allow"
          Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:HeadObject"]
          Resource = "${aws_s3_bucket.attachments.arn}/*"
        },
        {
          Effect   = "Allow"
          Action   = ["s3:PutObject", "s3:GetObject"]
          Resource = "${aws_s3_bucket.backups.arn}/*"
        },
        {
          Effect   = "Allow"
          Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
          Resource = [aws_kms_key.s3.arn, aws_kms_key.rds.arn]
        },
        {
          Effect   = "Allow"
          Action   = ["es:ESHttp*"]
          Resource = "${aws_opensearch_domain.main.arn}/*"
        },
        {
          Effect   = "Allow"
          Action   = ["ssm:GetParameter", "ssm:GetParameters"]
          Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/dlms/*"
        }
      ]
    })
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.name_prefix}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ecs_cpu
  memory                   = var.ecs_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "dlms-server"
    image     = var.container_image
    essential = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV",              value = var.environment },
      { name = "PORT",                  value = "3000" },
      { name = "PG_HOST",               value = aws_db_instance.postgres.address },
      { name = "PG_PORT",               value = "5432" },
      { name = "PG_DB",                 value = var.pg_db_name },
      { name = "PG_SSL",                value = "true" },
      { name = "OPENSEARCH_ENDPOINT",   value = "https://${aws_opensearch_domain.main.endpoint}" },
      { name = "ATTACHMENTS_BUCKET",    value = aws_s3_bucket.attachments.bucket },
      { name = "BACKUP_BUCKET",         value = aws_s3_bucket.backups.bucket },
      { name = "AWS_REGION",            value = var.aws_region },
    ]
    secrets = [
      { name = "PG_USER",           valueFrom = "/dlms/pg_user" },
      { name = "PG_PASS",           valueFrom = "/dlms/pg_pass" },
      { name = "OPENSEARCH_USER",   valueFrom = "/dlms/os_user" },
      { name = "OPENSEARCH_PASS",   valueFrom = "/dlms/os_pass" },
      { name = "SESSION_SECRET",    valueFrom = "/dlms/session_secret" },
      { name = "API_TOKEN",         valueFrom = "/dlms/api_token" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.environment == "prod" ? 2 : 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "dlms-server"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [desired_count]
  }
}

###############################################################################
# Application Load Balancer
###############################################################################

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  drop_invalid_header_fields = true

  access_logs {
    bucket  = aws_s3_bucket.backups.bucket
    prefix  = "alb-logs"
    enabled = true
  }
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = var.certificate_arn != "" ? "redirect" : "forward"
    dynamic "redirect" {
      for_each = var.certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
    dynamic "forward" {
      for_each = var.certificate_arn == "" ? [1] : []
      content { target_group { arn = aws_lb_target_group.app.arn } }
    }
  }
}

###############################################################################
# Auto Scaling
###############################################################################

resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = 10
  min_capacity       = var.environment == "prod" ? 2 : 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name_prefix}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
    target_value       = 70
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

###############################################################################
# Data sources & Outputs
###############################################################################

data "aws_caller_identity" "current" {}

output "alb_dns_name"        { value = aws_lb.main.dns_name }
output "rds_endpoint"        { value = aws_db_instance.postgres.address }
output "opensearch_endpoint" { value = aws_opensearch_domain.main.endpoint }
output "attachments_bucket"  { value = aws_s3_bucket.attachments.bucket }
output "backups_bucket"      { value = aws_s3_bucket.backups.bucket }
output "ecs_cluster_name"    { value = aws_ecs_cluster.main.name }
