# Official WhatsApp: multiple Meta applications

The ERP provisions applications before connecting numbers. Each application owns a dedicated callback path and can serve several WABAs and numbers. Baileys does not use this registry.

## Environment and storage

Set `WA_BUSINESS_ENCRYPTION_KEY` to a private, randomly generated 64-character hexadecimal key. App secrets and verification tokens are stored using AES-256-GCM. Keep this key with the database backup; changing it without re-encryption makes existing credentials unreadable until the ERP provisions the application again, which re-encrypts them with the current key, requires the webhook verification again and closes the linked official instances. Reactivate each number from the ERP with "Atualizar credenciais". `WA_BUSINESS_VERSION` and `WA_BUSINESS_URL` remain environment settings. Global app ID, app secret and verification token are no longer consumed.

Apply the provider migration `202610270002_meta_apps`. Existing instances are preserved without an application. Existing inbox rows without `metaAppId` are marked completed by the migration, are not assigned to any application and are purged with the other completed rows.

## Internal provisioning API

All `/official` endpoints require the global service API key in the `apikey` header. These endpoints are for the trusted ERP backend, never for browser access. The ERP validates tenant ownership before calling them.

- `PUT /official/apps/:id`: idempotently provision the ERP application UUID with `company_id`, immutable `app_id`, immutable `public_id`, `app_secret`, and `verify_token`. The public identifier is 32–64 URL-safe characters. An active App ID is unique. Existing applications cannot change owner or be restored after deletion.
- `GET /official/apps/:id`: return only `callback_verified_at` and `last_event_at`.
- `DELETE /official/apps/:id`: logically disable an application without linked instances; repeat deletion is safe.
- `POST /official/validate`: requires `meta_app_id`, `token`, `waba_id`, and `phone_number_id`. Token debugging uses that application's ID and secret and checks the exact requested phone across paginated results.
- `POST /official/:instanceName/activate`: validates credentials and subscribes the WABA. Initial activation requires `meta_app_id`; subsequent activation uses the persisted binding.
- Sample uploads use the application's App ID from the instance binding, never an environment-wide app.

Provisioning returns no secrets. Replacing the app secret closes linked official instances until credentials are validated and activated again. Replacing the verification token resets callback verification; update the Meta dashboard too.

## Public callbacks

Register `https://<public-base>/webhook/meta/<public_id>` on the corresponding Meta application and subscribe to `messages` and `message_template_status_update`.

GET checks `hub.mode`, `hub.verify_token`, and `hub.challenge`, then records callback verification. POST verifies `X-Hub-Signature-256` against the original bytes using that application's secret, persists the event with its application identity, and acknowledges only after persistence. Invalid signatures return 401; unknown or disabled applications return 404. The legacy `/webhook/meta` route is disabled.

Processing filters every instance by application, WABA, phone number and active connection state. Template status events use application and WABA scope. The durable inbox key includes the application identity; the worker retains its retry and recovery behavior. Valid events for unregistered resources are ignored and logged without credentials. A verified callback or accepted envelope does not prove that a particular conversation was delivered.

The original instance-create response keeps its legacy callback/token fields empty for compatibility. Obtain callback configuration through the ERP application screen instead.
