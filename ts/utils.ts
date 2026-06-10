import net from "net";

export function GetFreePort(): Promise<number> {

    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once("error", (error) => {
            reject(error);
        });

        server.once("listening", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close(() => {
                    reject(new Error("Failed to resolve ephemeral port"));
                });
                return;
            }

            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(address.port);
            });
        });

        server.listen(0);
    });
}
