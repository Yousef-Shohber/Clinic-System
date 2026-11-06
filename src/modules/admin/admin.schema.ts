import { z } from "zod";
import { Role } from "../../types/enums";

export const ListUsersDto = z.object({
  role: z.nativeEnum(Role).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type ListUsersDtoType = z.infer<typeof ListUsersDto>;
