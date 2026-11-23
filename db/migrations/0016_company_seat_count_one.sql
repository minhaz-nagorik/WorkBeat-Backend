-- company_seat_counts() grouped every device of every company, and the planner cannot push a
-- company filter into a plpgsql function: each staff single-company read counted the whole table.
-- An optional company ID limits it to that company; without it, every company as before.
BEGIN;
DROP FUNCTION company_seat_counts();
CREATE FUNCTION company_seat_counts(p_company_id uuid DEFAULT NULL) RETURNS TABLE (company_id uuid, seats_used int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_scope() NOT IN ('staff', 'system') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT c.id, count(d.id)::int FROM companies c
    LEFT JOIN devices d ON d.company_id = c.id AND d.deactivated_at IS NULL AND d.released_at IS NULL
   WHERE p_company_id IS NULL OR c.id = p_company_id
   GROUP BY c.id;
END $$;
REVOKE ALL ON FUNCTION company_seat_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION company_seat_counts(uuid) TO workbeat_api;
COMMIT;
