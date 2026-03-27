// Acorn adds start/end positions to all ESTree nodes.
// Augment the estree types to include them.
import "estree";

declare module "estree" {
  interface BaseNodeWithoutComments {
    start: number;
    end: number;
  }
}
