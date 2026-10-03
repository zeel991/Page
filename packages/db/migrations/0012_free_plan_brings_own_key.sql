-- The free plan includes no model spend on the operator's key: a free workspace
-- brings its own Anthropic key (Settings → Model key). Without one, an incident is
-- still detected, filed, reproduced and handed over, and stops short of a patch.
-- Open sign-up with an included amount let every new account spend the operator's
-- money. Raise it again with an UPDATE if the deployment can afford it.
UPDATE "plans" SET "included_model_usd" = NULL WHERE "id" = 'free';
