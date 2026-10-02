-- Add repair_notes field to engines for technician notes after repair completion
ALTER TABLE engines ADD COLUMN repair_notes TEXT;
