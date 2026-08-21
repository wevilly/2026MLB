# FantasyPros Live Fixture Tasks — Replit Must Perform

The project owner has already configured `FANTASYPROS_API_KEY` in Replit Secrets.

Do not ask the user to upload the key or manually provide public API documentation.

## Replit responsibilities

1. Read the current FantasyPros public API documentation itself.
2. Confirm which MLB endpoints are available under the configured plan.
3. Call the live API server-side.
4. Generate sanitized regression-test fixtures from real responses.
5. Strip credentials and account-specific sensitive metadata.
6. Commit only sanitized fixtures.

## Required live fixture categories

Create fixture files for available responses covering:

- MLB hitter daily projections
- MLB pitcher daily projections
- MLB projected lineups
- MLB non-projected/current lineups if endpoint behavior differs
- MLB player metadata
- MLB news

Suggested directory:

`tests/fixtures/fantasypros/`

## Required fixture metadata

Each fixture should record separately in a manifest:

- endpoint used
- HTTP method
- query parameters
- effective date
- retrieval timestamp UTC
- HTTP status
- row/entity count
- response checksum
- whether pagination exists
- quota/rate-limit headers when returned

Do not put authorization headers in fixture files.

## Discovery rule

Do not hard-code old CSV/export column assumptions.

Inspect the actual JSON schema returned by the live API and preserve every useful raw component field.

For future XBH research, preserve doubles, triples and HR projection components independently when supplied.

## Failure behavior

If an endpoint is not permitted under the user's API plan:

- record NOT ACCESSIBLE for that endpoint
- preserve the HTTP/error metadata
- continue with permitted endpoints
- do not invent substitute data

## Acceptance proof

Replit must show:

- sanitized fixture file names
- schema summary for each fixture
- sample normalized record
- raw-to-normalized mapping
- successful security test proving the API key is absent from client bundles, API responses and committed files
