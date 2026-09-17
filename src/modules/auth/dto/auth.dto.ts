import { IsEmail, IsString, Length, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RegisterDto {
  @ApiProperty({ example: "Acme Industries" })
  @IsString()
  @MaxLength(120)
  organizationName!: string;

  @ApiProperty({ example: "Asha" })
  @IsString()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: "Sharma" })
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ example: "hr@acme.example" })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  password!: string;
}

export class LoginDto {
  @ApiProperty({ example: "hr@acme.example" })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class VerifyEmailDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: "hr@acme.example" })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: "hr@acme.example" })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  token!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  password!: string;
}

export class AcceptInvitationNewUserDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  token!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @Length(12, 128)
  password!: string;
}

export class AcceptInvitationDto {
  @ApiProperty()
  @IsString()
  @Length(1, 256)
  token!: string;
}

export class SwitchOrganizationDto {
  @ApiProperty()
  @IsString()
  @Length(1, 64)
  organizationId!: string;
}
