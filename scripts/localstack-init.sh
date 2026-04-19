#!/bin/bash
# Creates local S3 buckets in LocalStack for development
awslocal s3 mb s3://dlms-attachments
awslocal s3 mb s3://dlms-backups
echo "LocalStack S3 buckets created: dlms-attachments, dlms-backups"
