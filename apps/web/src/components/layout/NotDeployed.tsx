"use client";

/**
 * A network the app serves that has no deployment yet (Sepolia until deployments/sepolia.json exists and the SDK is
 * regenerated). Instead of empty screens and failing reads, every page that needs the contracts shows one calm state:
 * what is true, the networks that are live, and the demo (which has a full Sepolia sample network). Nothing on this
 * page reads the chain or the server index, so there is no retry line and no error. The state disappears by itself on
 * the build that carries the deployment (lib/chains `deploymentOf`).
 */
import Link from "next/link";
import { useActiveChain, useSwitchNetwork } from "@/lib/activeChain";
import { ENABLED, chainMeta, deploymentOf } from "@/lib/chains";
import { DEMO_PARAM } from "@/lib/demo/mode";
import { networkName } from "@/lib/vocab";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/Surface";

/** Pages that work without a deployment: how it works, and the demo entry (its sample network has every chain). */
export const worksUndeployed = (path: string) => path.startsWith("/how-it-works") || path.startsWith("/developers/demo");

export function NotDeployed() {
  const { meta } = useActiveChain();
  const { switchNetwork } = useSwitchNetwork();
  const live = ENABLED.filter((c) => c.id !== meta.id && !!deploymentOf(c.id));
  return (
    <div data-testid="not-deployed" className="mx-auto max-w-[560px]">
      <EmptyState
        title={`Not deployed on ${meta.name} yet`}
        body={
          <>
            <p>
              Confluere supports {networkName(meta)}, but its contracts are not deployed there yet. Markets, vaults and your positions on {meta.name} appear here as
              soon as they are.
            </p>
            <p className="mt-1">{live.length > 0 ? `Meanwhile you can use ${live.map((c) => chainMeta(c.id).label).join(" or ")}, or look around in the demo.` : "Meanwhile you can look around in the demo."}</p>
          </>
        }
        actions={
          <>
            {live.map((c) => (
              <Button key={c.id} variant="secondary" size="md" onClick={() => void switchNetwork(c.id)} data-testid={`not-deployed-use-${c.id}`}>
                Use {c.name}
              </Button>
            ))}
            <Link href={`/developers/demo?chain=${meta.slug}&${DEMO_PARAM}=1`} className="textbtn text-body-sm">
              Try the demo on {meta.name}
            </Link>
          </>
        }
      />
    </div>
  );
}
