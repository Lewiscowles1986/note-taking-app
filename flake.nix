{
  description = "Note Haven declarative development toolchain";

  # The locked revision of this input (see flake.lock) is the single source of
  # truth for tool versions (Node.js, npm, git, docker CLI). Update it
  # deliberately with `scripts/update-nix.sh` — never by hand-editing flake.lock.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      # Every platform the team develops on: Linux (dev containers, CI) and
      # macOS (hosts running `nix develop` directly).
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Interactive shell for host-side development: `nix develop`
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.gitMinimal
          ];
        };
      });

      # Installable toolchain used to populate the dev container image
      # (see .devcontainer/Dockerfile). `buildEnv` produces one symlinked
      # bin/ directory that can be exposed to any user in the container.
      packages = forAllSystems (pkgs: {
        default = pkgs.buildEnv {
          name = "note-haven-toolchain";
          paths = [
            pkgs.nodejs_22
            pkgs.gitMinimal
            # Client only: the container talks to the HOST docker daemon
            # through a mounted socket (docs/technical/devcontainer/DIND.md).
            pkgs.docker-client
          ];
          pathsToLink = [ "/bin" ];
        };
      });
    };
}