import { IsEmail, IsEnum, IsString, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { MembershipRole } from "@prisma/client";

export class CreateInvitationDto {
  @ApiProperty({ example: "teammate@acme.example" })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role!: MembershipRole;
}

export class CreateOrganizationDto {
  @ApiProperty({ example: "Acme Industries" })
  @IsString()
  @MaxLength(120)
  name!: string;
}

export class ChangeMemberRoleDto {
  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role!: MembershipRole;
}
