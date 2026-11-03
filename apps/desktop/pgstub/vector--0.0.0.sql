-- A text-backed "vector" type so the pgvector migration applies; values are never read or indexed.
CREATE TYPE vector;
CREATE FUNCTION vector_in(cstring) RETURNS vector LANGUAGE internal IMMUTABLE STRICT AS 'textin';
CREATE FUNCTION vector_out(vector) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'textout';
CREATE FUNCTION vector_typmod_in(cstring[]) RETURNS integer LANGUAGE internal IMMUTABLE STRICT AS 'varchartypmodin';
CREATE FUNCTION vector_typmod_out(integer) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'varchartypmodout';
CREATE TYPE vector (
  INPUT = vector_in, OUTPUT = vector_out,
  TYPMOD_IN = vector_typmod_in, TYPMOD_OUT = vector_typmod_out,
  INTERNALLENGTH = VARIABLE, STORAGE = extended
);
