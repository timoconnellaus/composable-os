import { Button } from "../../../blocks/ui-button/button.tsx";

export const width = 720;

const variants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const sizes = ["xs", "sm", "default", "lg"] as const;

export default function Preview() {
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant === "default"
              ? "Book class"
              : variant === "destructive"
                ? "Cancel booking"
                : variant[0]?.toUpperCase() + variant.slice(1)}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {sizes.map((size) => (
          <Button key={size} size={size} variant="outline">
            {size === "default"
              ? "Default"
              : size === "xs"
                ? "Extra small"
                : size === "sm"
                  ? "Small"
                  : "Large"}
          </Button>
        ))}
        <Button disabled>Disabled</Button>
      </div>
    </div>
  );
}
