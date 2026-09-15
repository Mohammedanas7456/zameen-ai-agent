# Deploying to Cloud Run

The API and the web client ship as **one** Cloud Run service. The browser calls
the API with relative `/api` paths and streams chat over SSE, so same-origin
hosting means no CORS and no proxy in front of the stream.

Cloud Build builds the image from the `Dockerfile`, so Docker is not needed
locally.

## 1. Account, project, and APIs

If you use gcloud for more than one thing, keep this project in its own named
configuration so switching back leaves the other setup untouched:

```bash
gcloud config configurations create zameen && gcloud auth login
```

```bash
gcloud config set project YOUR_PROJECT_ID
```

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

## 2. Store the Vectara key in Secret Manager

The key must never be baked into the image or passed via `--set-env-vars`.
This pipes it straight out of `.env` without printing it:

```bash
grep '^VECTARA_API_KEY=' .env | cut -d= -f2- | tr -d '\n' | gcloud secrets create vectara-api-key --data-file=-
```

Let the Cloud Run runtime service account read it:

```bash
gcloud secrets add-iam-policy-binding vectara-api-key --member="serviceAccount:$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor
```

## 3. Deploy

`asia-south1` (Mumbai) is the closest region to Karachi users.

```bash
gcloud run deploy zameen-ai-agent --source . --region asia-south1 --allow-unauthenticated --timeout 3600 --set-secrets VECTARA_API_KEY=vectara-api-key:latest --set-env-vars VECTARA_BASE_URL=https://api.vectara.io/v2,VECTARA_CORPUS_KEY=zameen-karachi-properties,VECTARA_AGENT_KEY=zameen_property_assistant
```

Why these flags:

| Flag | Reason |
|---|---|
| `--timeout 3600` | Default is 300s. A long agent turn holds the SSE connection open; do not leave this at the default. |
| no `--min-instances` | Scales to zero, so an idle demo costs nothing. The trade-off is that the first visitor after a quiet period waits on a cold start; add `--min-instances 1` to keep one instance warm for a few dollars a month. |
| `--allow-unauthenticated` | Public demo. Remove it to require IAM. |
| no `--port` | Cloud Run injects `PORT=8080` and `config.ts` already reads it. |

## 4. Verify the deployment

```bash
URL=$(gcloud run services describe zameen-ai-agent --region asia-south1 --format='value(status.url)') && curl -s "$URL/api/health" && echo && curl -s -o /dev/null -w "shell %{http_code}\n" "$URL/"
```

**Then verify SSE specifically** — it is the one thing a platform change is most
likely to break, and a 200 on `/api/health` does not prove it:

```bash
URL=$(gcloud run services describe zameen-ai-agent --region asia-south1 --format='value(status.url)') && KEY=$(curl -s -X POST "$URL/api/session" -H 'Content-Type: application/json' -d '{}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).sessionKey") && curl -sN -X POST "$URL/api/chat" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$KEY\",\"message\":\"2 bed apartment in Clifton under 5 crore\"}" | head -c 600
```

Events should arrive incrementally. If the whole response lands at once, or the
connection drops early, something in front of Express is buffering.

## Updating

Re-run the `gcloud run deploy` command from step 3. Because the client is part
of the image, frontend changes redeploy the service too.

## Notes

- `data/facets.json` is baked into the image and read at runtime. Re-run the
  ingest pipeline and redeploy to refresh the snapshot.
- `CORS_ORIGINS` is unused in this topology; requests are same-origin.

## Deployed instance

| | |
|---|---|
| Project | `rayon-gcp-starter` |
| Service | `zameen-ai-agent` |
| Region | `asia-south1` |
| URL | https://zameen-ai-agent-agklzgshpq-el.a.run.app |

Two deviations from the flow above, both forced by holding `roles/editor` rather
than owner on that project:

**The Vectara key is an env var, not a Secret Manager reference.** `roles/editor`
can create a secret but can neither read its versions nor grant
`secretmanager.secretAccessor` to the runtime service account, so `--set-secrets`
could not work. The key is consequently readable in the service config and
revision history by anyone with view access on the project. An unused
`vectara-api-key` secret already exists there; once an owner grants the runtime
service account access, switch back by redeploying with
`--set-secrets VECTARA_API_KEY=vectara-api-key:latest` and dropping the key from
`--set-env-vars`.

**The service is private.** `--allow-unauthenticated` could not be applied because
`run.services.setIamPolicy` also needs owner. An owner can open it with:

```bash
gcloud run services add-iam-policy-binding zameen-ai-agent --region=asia-south1 --member=allUsers --role=roles/run.invoker
```

Until then, reach it with an identity token:

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" https://zameen-ai-agent-agklzgshpq-el.a.run.app/api/health
```
