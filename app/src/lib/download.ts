// Native: open the file in the system viewer, which offers save and share. @anlim
import { Linking } from "react-native";
export async function downloadFile(url: string, _name: string) { await Linking.openURL(url); }
