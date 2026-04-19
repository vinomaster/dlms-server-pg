# Acknowledgements

## Claude Code
The following PROMPT was used with `Claude` Version 1.3109.0 to produce the initial commits for the [DLMS Polyglot Server](https://github.com/vinomaster/dlms-server-pg) and [DLMS Polyglot Sample App](https://github.com/vinomaster/dlms-sample-pg) repos:

>Document Lifecycle Management System (DLMS) is an open source project that enables the creation of applications that depend on document and NoSql data workflow management and search. The project includes a [Server Repo](https://github.com/discoverfinancial/dlms-server) and a [Sample Application Tutorial](https://github.com/discoverfinancial/dlms-sample).

>The project repos are heavily dependent upon MongoDB. While MongoDB provides schema flexibility and rapid development, enterprise adoption of DLMS is impacted by the following MongoDB concerns:
    •    Compliance and regulatory ambiguity
    •    Data consistency and governance challenges
    •    Increasing operational and cost complexity
    •    Limitations in enterprise-grade search and analytics

>To address these concerns, we seek to provide an alternative architecture that still provides the necessary backup, restore, and fill-text search capabilities. The solution is to provide an AWS Polyglot alternative that leverages RDS PostgreSQL as the System of Record and OpenSearch as the Search Layer. Please review the DLMS repositories, and create and populate complimentary repos that will provide working solutions using the AWS Polyglot architecture.

[ADR-002-Polyglot-Architecture](./decisions/ADR-002-Polyglot-Architecture/README.md) provides the details behind the new DLMS Polyglot repos. 

## ChatGPT
Prior to initiating code development using `Claude`, an ADR discussion with ChatGPT Version 1.2026.051 was leveraged to frame an opinion for a migration proposal. [ADR-001-MongoDB-Migration](./decisions/ADR-001-MongoDB-Migration/README.md) represents the initial proposal along with visual diagrams for an executative summary of the ADR.