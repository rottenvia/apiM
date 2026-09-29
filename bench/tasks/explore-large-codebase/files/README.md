# fleetdesk

Back-office API for fleet operators: vehicles, drivers, trips, maintenance
tickets and invoicing, plus inbound webhooks from the telematics provider
and the payment processor.

    python -m fleetdesk.app --routes      # print the route table

Layout:

* `fleetdesk/http` - tiny WSGI-less HTTP layer (router, middleware, auth helpers)
* `fleetdesk/handlers` - HTTP handlers, one module per resource
* `fleetdesk/services` - business logic
* `fleetdesk/repositories` - data access
* `fleetdesk/storage` - database, batched journal writer, migrations
* `fleetdesk/events` - in-process event bus and default subscribers
* `fleetdesk/jobs` - scheduled jobs
* `fleetdesk/config` - defaults, profiles, loader
