# Argjira CRM Adapter Example

This folder shows how the assistant from `personal-software-assistant` maps into the first test project, `crm-invoice-gold-services`.

Use this example as a template for each future CRM, CMS, ecommerce site, or custom web app:

1. Create a `toolRegistry` with approved read-only business tools.
2. Create `contextSources` that turn deterministic business data into Markdown context documents.
3. Create a `pageRegistry` with the host app's real frontend routes for draft action links.
4. Mount the generic Express router with the host app's auth middleware.
5. Mount the generic React `AssistantButton` with the host app's API client and role checks.

The key rule is that the model never runs raw SQL. It only calls named functions exposed by the adapter.
