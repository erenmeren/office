-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "canClone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
