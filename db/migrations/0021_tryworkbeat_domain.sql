-- Production domain is tryworkbeat.com: {slug}.tryworkbeat.com resolves, {slug}.workbeat.io no longer does.
-- Same body as 0002 with only the domain changed.
BEGIN;
CREATE OR REPLACE FUNCTION company_by_host(p_host citext)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM companies
   WHERE (custom_domain = rtrim(p_host::text, '.') AND custom_domain_status = 'active')
      OR (lower(rtrim(p_host::text, '.')) ~ '^[a-z0-9]+(-[a-z0-9]+)*\.tryworkbeat\.com$'
          AND slug = split_part(lower(p_host::text), '.', 1))
   LIMIT 1
$$;
COMMIT;
