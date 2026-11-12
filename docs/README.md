# WholePlan documentation

- [Setup and configuration](../README.md)
- [Security audit and deployment boundaries](SECURITY-AUDIT.md)
- [Original demo and submission plan](DEMO.md)
- [Original research and validation](VALIDATION.md)
- [Brand assets and source artwork](../design/brand/README.md)

For changes, use a separate branch and run `npm test`. For payment engine changes, also run `npm run demo:evidence` and inspect the transition and amount for each scenario. Use the local simulator or PayPal Sandbox for checkout verification.

Send security findings privately to a repository maintainer. Include the affected version and a description of the impact. Keep credentials, session cookies, payer details, and private logs out of shared reports.
